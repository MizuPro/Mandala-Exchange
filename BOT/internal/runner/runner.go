// Package runner mengorkestrasi eksekusi strategy untuk semua bot aktif.
// Runner dipanggil oleh Scheduler pada setiap tick segment yang diizinkan untuk order.
package runner

import (
	"context"
	"sync/atomic"
	"time"

	"github.com/Mandala-Exchange/bot-v2/internal/client/bei"
	"github.com/Mandala-Exchange/bot-v2/internal/client/mats"
	"github.com/Mandala-Exchange/bot-v2/internal/logger"
	"github.com/Mandala-Exchange/bot-v2/internal/metrics"
	"github.com/Mandala-Exchange/bot-v2/internal/queue"
	"github.com/Mandala-Exchange/bot-v2/internal/registry"
	"github.com/Mandala-Exchange/bot-v2/internal/strategy"
)

// Runner adalah orkestrator strategy per-segment.
// Ia tidak tahu apa-apa tentang jadwal sesi — itu urusan Scheduler.
type Runner struct {
	reg         *registry.Registry
	beiClient   *bei.Client
	matsClient  *mats.Client
	ordQueue    *queue.OrderQueue
	strategyReg *strategy.StrategyRegistry
	metrics     *metrics.Manager

	// Statistik lifetime (untuk debug/admin)
	totalDecisions atomic.Int64
	totalEnqueued  atomic.Int64
	totalDropped   atomic.Int64
}

func (r *Runner) SetMetrics(manager *metrics.Manager) {
	r.metrics = manager
}

// New membuat Runner baru.
func New(
	reg *registry.Registry,
	beiClient *bei.Client,
	matsClient *mats.Client,
	ordQueue *queue.OrderQueue,
	strategyReg *strategy.StrategyRegistry,
) *Runner {
	return &Runner{
		reg:         reg,
		beiClient:   beiClient,
		matsClient:  matsClient,
		ordQueue:    ordQueue,
		strategyReg: strategyReg,
	}
}

// RunBotDecisions menjalankan strategy untuk semua bot aktif pada segment yang diberikan.
// Dipanggil dari Scheduler saat segmen berubah ke opening_auction, continuous, atau closing_auction.
//
// Setiap bot berjalan secara sequential (tidak concurrent per-bot) untuk menghindari
// race condition pada shared state. Jumlah bot Fase 3 hanya 10, jadi sequential sudah cukup.
// Fase 4+ bisa switch ke worker pool jika perlu.
func (r *Runner) RunBotDecisions(ctx context.Context, segment string) {
	if ctx.Err() != nil {
		return
	}

	r.RunBotDecisionsFor(ctx, segment, r.reg.ListBots())
}

// RunBotDecisionsFor mengevaluasi subset bot yang sudah jatuh tempo menurut scheduler.
func (r *Runner) RunBotDecisionsFor(ctx context.Context, segment string, bots []*registry.BotInstance) {
	if ctx.Err() != nil {
		return
	}

	beiSnap := r.beiClient.GetSnapshot()
	matsState := r.matsClient.GetState()

	if len(bots) == 0 {
		return
	}

	var decisionsProduced, decisionsEnqueued, decisionsDropped int

	start := time.Now()
	for _, bot := range bots {
		if ctx.Err() != nil {
			break
		}

		// Skip bot yang tidak aktif atau bankrupt
		status := bot.GetStatus()
		if status == "bankrupt" || status == "paused" {
			continue
		}

		strat := r.strategyReg.Get(bot.Strategy)
		decisions := strat.Decide(ctx, bot, beiSnap, matsState, segment)
		botDecisions := int64(len(decisions))
		var botEnqueued, botDropped int64

		for _, dec := range decisions {
			decisionsProduced++
			r.totalDecisions.Add(1)

			if r.ordQueue.Enqueue(dec) {
				decisionsEnqueued++
				r.totalEnqueued.Add(1)
				botEnqueued++

				// Update session order counter untuk bot ini
				bot.AddOrderCount(resolveSessionID(beiSnap))
			} else {
				decisionsDropped++
				r.totalDropped.Add(1)
				botDropped++
				logger.Warn("Runner: order decision dropped (queue full)",
					"bot_id", bot.ExternalBotID,
					"symbol", dec.Symbol,
					"side", dec.Side,
				)
			}
		}
		if r.metrics != nil {
			r.metrics.RecordRunner(resolveSessionID(beiSnap), bot.Strategy, 1, botDecisions, botEnqueued, botDropped)
		}
	}

	elapsed := time.Since(start)
	if decisionsProduced > 0 || len(bots) > 0 {
		logger.Info("Runner: bot decisions completed",
			"segment", segment,
			"bots_evaluated", len(bots),
			"decisions_produced", decisionsProduced,
			"decisions_enqueued", decisionsEnqueued,
			"decisions_dropped", decisionsDropped,
			"elapsed_ms", elapsed.Milliseconds(),
		)
	}
}

// RunContinuousTick adalah alias untuk RunBotDecisions("continuous").
// Dipanggil dari goroutine ticker di Scheduler saat segment = continuous.
func (r *Runner) RunContinuousTick(ctx context.Context) {
	r.RunBotDecisions(ctx, "continuous")
}

// Stats mengembalikan statistik lifetime runner.
func (r *Runner) Stats() (totalDecisions, totalEnqueued, totalDropped int64) {
	return r.totalDecisions.Load(), r.totalEnqueued.Load(), r.totalDropped.Load()
}

func (r *Runner) SessionMetrics() (metrics.Snapshot, bool) {
	if r.metrics == nil {
		return metrics.Snapshot{}, false
	}
	return r.metrics.Snapshot(), true
}

// resolveSessionID menggunakan session instance ID resmi dari BEI.
// Tanggal hanya menjadi fallback saat endpoint lama tidak mengembalikan ID.
func resolveSessionID(snap bei.Snapshot) string {
	if snap.Session != nil && snap.Session.ID != "" {
		return snap.Session.ID
	}
	return time.Now().Format("2006-01-02")
}
