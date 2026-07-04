package ipo

import (
	"context"
	"encoding/json"
	"math/rand"
	"sync"
	"time"

	bei "github.com/Mandala-Exchange/bot-v2/internal/client/bei"
	sekuritas "github.com/Mandala-Exchange/bot-v2/internal/client/sekuritas"
	"github.com/Mandala-Exchange/bot-v2/internal/config"
	"github.com/Mandala-Exchange/bot-v2/internal/logger"
	"github.com/Mandala-Exchange/bot-v2/internal/metrics"
	"github.com/Mandala-Exchange/bot-v2/internal/portfolio"
	"github.com/Mandala-Exchange/bot-v2/internal/registry"
)

// Manager adalah entry point tunggal untuk semua operasi IPO di BOT.
// Scheduler memanggil OnPollResult setiap 10-15 detik.
// Main.go memanggil ReconcileOnStartup setelah bulk snapshot.
// Event stream consumer memanggil OnAccountEvent saat menerima ipo_subscription_updated.
type Manager struct {
	mu          sync.Mutex // melindungi akses concurrent ke registry & executor
	ipoReg      *IPORegistry
	sekClient   *sekuritas.Client
	botRegistry *registry.Registry
	cfg         config.IPOConfig
	metrics     *metrics.Manager
	rng         *rand.Rand
}

// NewManager membuat IPOManager baru.
// Jika cfg.DeterministicSeed != 0, RNG akan menggunakan seed tersebut (untuk test).
func NewManager(
	ipoReg *IPORegistry,
	sekClient *sekuritas.Client,
	botRegistry *registry.Registry,
	cfg config.IPOConfig,
	met *metrics.Manager,
) *Manager {
	var rng *rand.Rand
	if cfg.DeterministicSeed != 0 {
		rng = rand.New(rand.NewSource(cfg.DeterministicSeed)) //nolint:gosec
	} else {
		rng = rand.New(rand.NewSource(time.Now().UnixNano())) //nolint:gosec
	}
	return &Manager{
		ipoReg:      ipoReg,
		sekClient:   sekClient,
		botRegistry: botRegistry,
		cfg:         cfg,
		metrics:     met,
		rng:         rng,
	}
}

// OnPollResult dipanggil scheduler setiap kali ada hasil poll GET /bot/ipo-lifecycle.
// Memproses diff, mengevaluasi eligibility semua bot, dan menjalankan executor.
func (m *Manager) OnPollResult(ctx context.Context, incoming []bei.IPOLifecycle) {
	if !m.cfg.EnableIPOSubscription {
		return
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	diff := Diff(m.ipoReg, incoming)

	// Update registry untuk semua incoming terlebih dahulu
	for _, ipo := range incoming {
		if isNew, _ := m.ipoReg.Upsert(ipo); isNew {
			logger.Info("IPO baru ditemukan", "ipo_id", ipo.ID, "symbol", ipo.Symbol, "status", ipo.Status)
			m.metrics.RecordIPOEvent("discovered")
		}
	}

	// Log summary diff
	if len(diff.NewEvents)+len(diff.VersionUpdated)+len(diff.NowListed)+len(diff.NowCancelled) > 0 {
		logger.Info("IPO poll diff",
			"new", len(diff.NewEvents),
			"version_updated", len(diff.VersionUpdated),
			"now_listed", len(diff.NowListed),
			"now_cancelled", len(diff.NowCancelled),
		)
	}

	// Handle cancelled: bersihkan pending decision
	for _, ipo := range diff.NowCancelled {
		m.handleCancelled(ipo)
	}

	// Handle listed: set attention expiry untuk Fase 5F
	for _, ipo := range diff.NowListed {
		m.handleListed(ipo)
	}

	// Evaluasi semua bot untuk IPO baru dan version update
	toEvaluate := append(diff.NewEvents, diff.VersionUpdated...)
	for _, ipo := range toEvaluate {
		entry, ok := m.ipoReg.Get(ipo.ID)
		if !ok {
			continue
		}
		// Skip jika sudah diproses di versi ini
		if entry.ProcessedVersion >= ipo.Version {
			continue
		}
		m.evaluateAndSubscribe(ctx, ipo)
	}
}

// evaluateAndSubscribe mengevaluasi semua bot untuk satu IPO dan menjalankan subscription.
// Bot event_driven dievaluasi pertama (prioritas), kemudian bot lainnya.
func (m *Manager) evaluateAndSubscribe(ctx context.Context, ipo bei.IPOLifecycle) {
	bots := m.botRegistry.ListBots()

	// Pisahkan event_driven (prioritas) dari yang lain
	var eventDriven []*registry.BotInstance
	var others []*registry.BotInstance
	for _, bot := range bots {
		if bot.Strategy == "event_driven" {
			eventDriven = append(eventDriven, bot)
		} else {
			others = append(others, bot)
		}
	}

	for _, bot := range append(eventDriven, others...) {
		decision := Plan(bot, ipo, m.cfg, m.rng)
		if !decision.ShouldSubscribe {
			if decision.Reason == "eligible" {
				// Seharusnya tidak terjadi, tapi guard
				continue
			}
			logger.Debug("IPO Plan: bot tidak subscribe",
				"bot_id", bot.ExternalBotID,
				"ipo_id", ipo.ID,
				"reason", decision.Reason,
			)
			continue
		}

		m.metrics.RecordIPOEvent("eligible")
		logger.Info("IPO Plan: bot eligible",
			"bot_id", bot.ExternalBotID,
			"ipo_id", ipo.ID,
			"shares", decision.RequestedShares,
			"reason", decision.Reason,
		)

		// Execute di goroutine agar tidak memblokir loop bot lain
		// Goroutine dibatasi: satu per (bot, IPO) — tidak ada unbounded goroutine
		botRef := bot
		decisionRef := decision
		go func() {
			execErr := Execute(ctx, botRef, decisionRef, m.sekClient, m.ipoReg, m.metrics)
			if execErr != nil {
				// Cek jika perlu reconcile (outcome unknown)
				state, ok := botRef.GetIPOSubscription(decisionRef.IPOEventID)
				if ok && state.Status == "pending_reconcile" {
					_ = ReconcileAfterTimeout(ctx, botRef, decisionRef.IPOEventID, m.sekClient, m.metrics)
				}
			}
		}()
	}
}

// handleCancelled membersihkan pending decision untuk IPO yang dibatalkan.
func (m *Manager) handleCancelled(ipo bei.IPOLifecycle) {
	bots := m.botRegistry.ListBots()
	for _, bot := range bots {
		if bot.HasActiveIPOSubscription(ipo.ID) {
			// Biarkan subscription aktif — Sekuritas akan proses refund/reversal
			logger.Warn("IPO cancelled tapi bot masih punya active subscription",
				"bot_id", bot.ExternalBotID,
				"ipo_id", ipo.ID,
			)
		} else {
			bot.RemoveIPOSubscription(ipo.ID)
		}
	}
	m.ipoReg.MarkProcessed(ipo.ID, ipo.Version)
	m.metrics.RecordIPOEvent("failed") // cancelled = failed dari perspektif bot
}

// handleListed menandai IPO yang sudah listing untuk attention boost di Fase 5F.
func (m *Manager) handleListed(ipo bei.IPOLifecycle) {
	// Attention expiry: 2 jam pasca listing
	attentionExpiry := time.Now().Add(2 * time.Hour)
	m.ipoReg.SetAttentionExpiry(ipo.ID, attentionExpiry)
	m.ipoReg.MarkProcessed(ipo.ID, ipo.Version)
	m.metrics.RecordIPOEvent("listed")
	logger.Info("IPO listed", "ipo_id", ipo.ID, "symbol", ipo.Symbol, "attention_until", attentionExpiry)
}

// ReconcileOnStartup dijalankan saat BOT pertama kali start, sebelum scheduler aktif.
// Memastikan state bot sudah terisi dari Sekuritas snapshot sebelum evaluasi pertama.
func (m *Manager) ReconcileOnStartup(ctx context.Context, snap portfolio.Snapshot) {
	m.mu.Lock()
	defer m.mu.Unlock()

	bots := m.botRegistry.ListBots()
	ReconcileOnStartup(bots, m.ipoReg, snap)
}

// IPOSubscriptionUpdatedPayload adalah payload dari event ipo_subscription_updated di WebSocket Sekuritas.
type IPOSubscriptionUpdatedPayload struct {
	SubscriptionID string `json:"subscription_id"`
	IPOEventID     string `json:"ipo_event_id"`
	Status         string `json:"status"`
	AllocatedShares int64 `json:"allocated_shares"`
	ActualDebitIDR  string `json:"actual_debit_idr"`
	EventVersion   int    `json:"event_version"`
}

// OnAccountEvent dipanggil saat menerima event ipo_subscription_updated dari WebSocket Sekuritas.
// Mengupdate state subscription bot dan mencatat metrics yang relevan.
func (m *Manager) OnAccountEvent(ctx context.Context, accountID string, rawPayload json.RawMessage) {
	var payload IPOSubscriptionUpdatedPayload
	if err := json.Unmarshal(rawPayload, &payload); err != nil {
		logger.Error("IPO OnAccountEvent: gagal parse payload", "account_id", accountID, "error", err.Error())
		return
	}

	bot, ok := m.botRegistry.GetBot(accountID)
	if !ok {
		logger.Warn("IPO OnAccountEvent: bot tidak ditemukan", "account_id", accountID)
		return
	}

	// Update state subscription
	existing, hasSub := bot.GetIPOSubscription(payload.IPOEventID)
	if !hasSub {
		// Subscription baru yang kita tidak track (mis. dari restart lama) — create entry
		existing = registry.IPOSubscriptionState{}
	}
	existing.SubscriptionID = payload.SubscriptionID
	existing.Status = payload.Status
	existing.RequestedShares = existing.RequestedShares // tidak berubah
	bot.SetIPOSubscription(payload.IPOEventID, existing)

	logger.Info("IPO OnAccountEvent: state diupdate",
		"bot_id", bot.ExternalBotID,
		"ipo_event_id", payload.IPOEventID,
		"status", payload.Status,
	)

	// Catat metrics berdasarkan status baru
	switch payload.Status {
	case "allocated":
		m.metrics.RecordIPOEvent("allocated")
	case "settled":
		// settled = alokasi selesai dan saham sudah masuk
		if payload.AllocatedShares < existing.RequestedShares {
			m.metrics.RecordIPOEvent("refunded") // partial/zero allocation
		}
	case "reversed", "cancelled":
		bot.RemoveIPOSubscription(payload.IPOEventID)
		m.metrics.RecordIPOEvent("failed")
	}
}
