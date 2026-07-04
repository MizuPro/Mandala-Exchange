package scheduler

import (
	"context"
	"time"

	"github.com/Mandala-Exchange/bot-v2/internal/client/bei"
	"github.com/Mandala-Exchange/bot-v2/internal/client/sekuritas"
	"github.com/Mandala-Exchange/bot-v2/internal/config"
	"github.com/Mandala-Exchange/bot-v2/internal/logger"
	"github.com/Mandala-Exchange/bot-v2/internal/registry"
	"github.com/Mandala-Exchange/bot-v2/internal/runner"
)

// Scheduler memantau perubahan session segment dan mengaktifkan strategy runner
// pada segment yang diizinkan: opening_auction, continuous, closing_auction.
type Scheduler struct {
	beiClient       *bei.Client
	sekuritasClient *sekuritas.Client
	reg             *registry.Registry
	botRunner       *runner.Runner
	cfg             config.SchedulerConfig
	pollInterval    time.Duration

	lastSegment      string
	cancelContinuous context.CancelFunc // untuk stop continuous ticker goroutine
	planner          *Planner
}

// NewScheduler membuat Scheduler baru.
// botRunner boleh nil hanya untuk testing — jika nil, segment transitions di-log tapi tidak ada order.
func NewScheduler(
	beiClient *bei.Client,
	sekuritasClient *sekuritas.Client,
	reg *registry.Registry,
	botRunner *runner.Runner,
	cfg config.SchedulerConfig,
	pollInterval time.Duration,
) *Scheduler {
	if pollInterval <= 0 {
		pollInterval = 5 * time.Second
	}
	return &Scheduler{
		beiClient:       beiClient,
		sekuritasClient: sekuritasClient,
		reg:             reg,
		botRunner:       botRunner,
		cfg:             cfg,
		pollInterval:    pollInterval,
		planner:         NewPlanner(cfg.Seed, cfg.Intervals),
	}
}

// Start memulai poll loop di background goroutine.
func (s *Scheduler) Start(ctx context.Context) {
	go s.pollLoop(ctx)
}

func (s *Scheduler) pollLoop(ctx context.Context) {
	logger.Info("Scheduler poll loop started")
	ticker := time.NewTicker(s.pollInterval)
	defer ticker.Stop()

	// Initial fetch semua state BEI saat startup
	if err := s.beiClient.PollAllState(ctx); err != nil {
		logger.Error("Initial BEI full state fetch failed", "error", err.Error())
	}

	for {
		select {
		case <-ctx.Done():
			// Bersihkan continuous ticker jika masih berjalan
			if s.cancelContinuous != nil {
				s.cancelContinuous()
			}
			logger.Info("Scheduler poll loop exiting due to context cancel")
			return
		case <-ticker.C:
			s.tick(ctx)
		}
	}
}

func (s *Scheduler) tick(ctx context.Context) {
	// Fast poll: hanya ambil session state (ringan)
	state, err := s.beiClient.PollSessionState(ctx)
	if err != nil {
		logger.Error("Failed to poll session state", "error", err.Error())
		return
	}

	currentSegment := state.Status
	if currentSegment == s.lastSegment {
		return // Tidak ada perubahan segment
	}

	logger.Info("Session segment transition detected",
		"from", s.lastSegment,
		"to", currentSegment,
	)

	// Handle transisi dari segment sebelumnya
	s.onExitSegment(ctx, s.lastSegment)

	// Handle transisi ke segment baru
	s.onEnterSegment(ctx, currentSegment)

	s.lastSegment = currentSegment
}

// onExitSegment dipanggil saat keluar dari sebuah segment.
func (s *Scheduler) onExitSegment(_ context.Context, segment string) {
	switch segment {
	case "continuous":
		// Stop continuous ticker goroutine
		if s.cancelContinuous != nil {
			logger.Info("Scheduler: stopping continuous ticker")
			s.cancelContinuous()
			s.cancelContinuous = nil
		}
	}
}

// onEnterSegment dipanggil saat masuk ke sebuah segment.
func (s *Scheduler) onEnterSegment(ctx context.Context, segment string) {
	switch segment {
	case "pre_open":
		logger.Info("Scheduler: pre_open — refreshing all BEI state and bot portfolios")
		// Slow poll: refresh semua data referensi BEI (rules, fees, listing, IPO, news, dll)
		if err := s.beiClient.PollAllState(ctx); err != nil {
			logger.Error("BEI full poll failed in pre_open", "error", err.Error())
		}
		// Refresh portfolio semua bot dari Sekuritas (satu kali per sesi)
		s.refreshPortfolios(ctx)

	case "opening_auction":
		logger.Info("Scheduler: opening_auction — running bot decisions")
		if s.botRunner != nil {
			s.botRunner.RunBotDecisions(ctx, "opening_auction")
		}

	case "continuous":
		logger.Info("Scheduler: continuous — starting periodic bot ticker")
		if s.botRunner != nil {
			s.planner.Reset(s.reg.ListBots(), time.Now())
			// Buat context baru untuk continuous ticker agar bisa di-cancel
			tickCtx, cancel := context.WithCancel(ctx)
			s.cancelContinuous = cancel
			go s.continuousTickerLoop(tickCtx)
		}

	case "pre_close":
		logger.Info("Scheduler: pre_close — no orders allowed")

	case "non_cancellation":
		logger.Info("Scheduler: non_cancellation — no cancel/amend allowed")

	case "closing_auction":
		logger.Info("Scheduler: closing_auction — running bot decisions")
		if s.botRunner != nil {
			s.botRunner.RunBotDecisions(ctx, "closing_auction")
		}

	case "post_closing", "closed":
		logger.Info("Scheduler: session end", "segment", segment)
		// Session summary bisa ditambahkan di sini di Fase 4
		if s.botRunner != nil {
			dec, enq, drop := s.botRunner.Stats()
			logger.Info("Scheduler: session runner stats",
				"total_decisions", dec,
				"total_enqueued", enq,
				"total_dropped", drop,
			)
			if snapshot, ok := s.botRunner.SessionMetrics(); ok {
				logger.Info("Scheduler: current session metrics",
					"session_id", snapshot.SessionID,
					"bots_evaluated", snapshot.Total.BotsEvaluated,
					"decisions", snapshot.Total.Decisions,
					"enqueued", snapshot.Total.Enqueued,
					"dropped", snapshot.Total.Dropped,
					"accepted", snapshot.Total.Accepted,
					"filled", snapshot.Total.Filled,
					"rejected", snapshot.Total.Rejected,
					"cancelled", snapshot.Total.Cancelled,
					"expired", snapshot.Total.Expired,
				)
			}
		}
	}
}

// continuousTickerLoop menjalankan RunContinuousTick secara periodik dengan interval random.
// Berjalan di goroutine tersendiri dan di-cancel saat keluar dari segment continuous.
func (s *Scheduler) continuousTickerLoop(ctx context.Context) {
	scanInterval := s.cfg.ScanInterval
	if scanInterval <= 0 {
		scanInterval = time.Second
	}
	ticker := time.NewTicker(scanInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			logger.Info("Scheduler: continuous ticker stopped")
			return
		case now := <-ticker.C:
			if ctx.Err() != nil {
				return
			}
			due := s.planner.Due(s.reg.ListBots(), now)
			if len(due) == 0 {
				continue
			}
			logger.Debug("Scheduler: due bot batch", "count", len(due))
			s.botRunner.RunBotDecisionsFor(ctx, "continuous", due)
		}
	}
}

// refreshPortfolios mengambil snapshot portfolio semua bot dari Sekuritas
// dan mengupdate state in-memory, termasuk cek distressed/bankrupt.
func (s *Scheduler) refreshPortfolios(ctx context.Context) {
	bots := s.reg.ListBots()
	if len(bots) == 0 {
		return
	}

	accountIDs := make([]string, 0, len(bots))
	for _, b := range bots {
		accountIDs = append(accountIDs, b.AccountID)
	}

	// Batch snapshot dalam chunk 100
	for i := 0; i < len(accountIDs); i += 100 {
		end := i + 100
		if end > len(accountIDs) {
			end = len(accountIDs)
		}
		chunk := accountIDs[i:end]

		snap, err := s.sekuritasClient.BulkSnapshot(ctx, chunk)
		if err != nil {
			logger.Error("Failed to fetch bulk portfolio snapshot",
				"chunk_size", len(chunk),
				"error", err.Error(),
			)
			continue
		}

		for _, acc := range snap.Accounts {
			if b, ok := s.reg.GetBot(acc.AccountID); ok {
				b.UpdateFromSnapshot(acc)
				s.updateBotDistressBankruptcy(b)
			}
		}
	}
	logger.Info("Refreshed portfolios from Sekuritas for all registered bots")
}

// updateBotDistressBankruptcy memeriksa net worth bot dan menetapkan status
// distressed atau bankrupt sesuai threshold.
// BUG FIX: versi lama secara tidak sengaja me-reset Positions sebelum dicek.
func (s *Scheduler) updateBotDistressBankruptcy(b *registry.BotInstance) {
	availCash, reservedCash, pendingCash := b.GetCash()
	totalCash := availCash + reservedCash + pendingCash

	// Gunakan method yang aman (exported) — tidak perlu akses mu langsung
	hasPositions := b.HasAnyPosition()
	hasOpenOrders := b.HasOpenOrders()

	// Threshold bankrupt: cash < Rp5.000, tidak ada posisi, tidak ada open order
	if totalCash < 5000 && !hasPositions && !hasOpenOrders {
		if b.GetStatus() != "bankrupt" {
			b.SetStatus("bankrupt")
			logger.Warn("Bot transitioned to bankrupt",
				"external_bot_id", b.ExternalBotID,
				"account_id", b.AccountID,
				"total_cash", totalCash,
			)
		}
	} else if totalCash < 50000 {
		// Threshold distressed: cash < Rp50.000
		if b.GetStatus() != "distressed" && b.GetStatus() != "bankrupt" {
			b.SetStatus("distressed")
			logger.Warn("Bot transitioned to distressed",
				"external_bot_id", b.ExternalBotID,
				"account_id", b.AccountID,
				"total_cash", totalCash,
			)
		}
	} else {
		// Recovery: dari distressed kembali ke active
		if b.GetStatus() == "distressed" {
			b.SetStatus("active")
			logger.Info("Bot recovered from distressed to active",
				"external_bot_id", b.ExternalBotID,
			)
		}
	}
}
