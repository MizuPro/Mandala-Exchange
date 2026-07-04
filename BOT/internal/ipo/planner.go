package ipo

import (
	"fmt"
	"math/rand"
	"time"

	bei "github.com/Mandala-Exchange/bot-v2/internal/client/bei"
	"github.com/Mandala-Exchange/bot-v2/internal/config"
	"github.com/Mandala-Exchange/bot-v2/internal/registry"
)

// SubscriptionDecision adalah hasil evaluasi planner untuk satu pasangan (bot, IPO).
type SubscriptionDecision struct {
	ShouldSubscribe bool
	IPOEventID      string
	RequestedShares int64
	IdempotencyKey  string
	DecisionVersion int
	Reason          string // untuk logging: "eligible", "paused", "window_closed", dll.
}

// Plan mengevaluasi apakah sebuah bot boleh dan sebaiknya melakukan subscription IPO.
// Semua strategi bot yang berstatus active boleh subscribe. Bot event_driven mendapat
// multiplier 1.0x (full exposure); bot strategi lain mendapat multiplier 0.5x.
//
// rng harus disuplai dari luar untuk determinisme saat test.
func Plan(
	bot *registry.BotInstance,
	ipo bei.IPOLifecycle,
	cfg config.IPOConfig,
	rng *rand.Rand,
) SubscriptionDecision {
	base := SubscriptionDecision{
		IPOEventID:      ipo.ID,
		DecisionVersion: 1,
	}

	// Guard 1: Status bot
	status := bot.GetStatus()
	if status != "active" {
		base.Reason = fmt.Sprintf("bot_status_%s", status)
		return base
	}

	// Guard 2: Tidak boleh punya active subscription untuk IPO ini
	if bot.HasActiveIPOSubscription(ipo.ID) {
		existing, _ := bot.GetIPOSubscription(ipo.ID)
		base.Reason = "already_subscribed"
		base.DecisionVersion = existing.DecisionVersion
		return base
	}

	// Guard 3: Subscription window aktif
	now := time.Now()
	if now.Before(ipo.SubscriptionStart) || now.After(ipo.SubscriptionEnd) {
		base.Reason = "window_closed"
		return base
	}

	// Guard 4: SubscriptionLotSize harus valid
	if ipo.SubscriptionLotSize <= 0 || ipo.OfferingPriceIDR <= 0 {
		base.Reason = "invalid_ipo_params"
		return base
	}

	// Hitung priority multiplier berdasarkan strategi
	var priorityMultiplier float64
	if bot.Strategy == "event_driven" {
		priorityMultiplier = 1.0
	} else {
		priorityMultiplier = 0.5
	}

	// Hitung exposure berdasarkan risk_profile dari config
	// Ambil RiskProfile dari BotConfig. Jika tidak ada di map, gunakan "moderate" sebagai fallback.
	// Catatan: RiskProfile tersimpan di BotInstance sebagai field yang perlu ditambahkan.
	// Sementara itu, kita ambil dari ExternalBotID hash untuk determinisme, atau default moderate.
	exposurePct, ok := cfg.MaxCashExposurePct[bot.Strategy]
	if !ok {
		// Fallback: cari berdasarkan key umum atau gunakan moderate
		exposurePct = cfg.MaxCashExposurePct["moderate"]
		if exposurePct == 0 {
			exposurePct = 0.10
		}
	}

	// Gunakan risk profile jika tersedia (akan diisi saat BotInstance diperbarui)
	// Untuk saat ini kita tetap pakai exposure berdasarkan strategy sebagai proxy.

	availableCash, _, _ := bot.GetCash()
	maxCashIDR := int64(float64(availableCash) * exposurePct * priorityMultiplier)

	// Hitung jumlah lot yang mampu dibeli
	costPerLot := ipo.OfferingPriceIDR * ipo.SubscriptionLotSize
	lotsAffordable := maxCashIDR / costPerLot

	// Guard 5: Overpriced IPO blocking
	if ipo.IPOArchetype == "overpriced_ipo" && ipo.FairValueInitial > 0 {
		if ipo.OfferingPriceIDR > int64(float64(ipo.FairValueInitial)*1.10) {
			// Hanya event_driven dan aggressive yang tetap subscribe
			if bot.Strategy != "event_driven" {
				base.Reason = "overpriced_ipo_blocked"
				return base
			}
		}
	}

	// Guard 6: Cukup cash?
	if lotsAffordable <= 0 {
		base.Reason = "insufficient_cash"
		return base
	}

	// Tambahkan random factor ±15% untuk variasi antar-bot
	// Hasil dibulatkan ke bawah ke kelipatan 1 lot
	factor := 1.0
	if rng != nil {
		factor = 0.85 + rng.Float64()*0.30 // 0.85 - 1.15
	}
	lotsWithJitter := int64(float64(lotsAffordable) * factor)
	if lotsWithJitter < 1 {
		lotsWithJitter = 1
	}
	requiredShares := lotsWithJitter * ipo.SubscriptionLotSize

	// Pastikan final cash check
	if requiredShares*ipo.OfferingPriceIDR > availableCash {
		// Kurangi 1 lot jika melebihi cash setelah jitter
		lotsWithJitter--
		if lotsWithJitter < 1 {
			base.Reason = "insufficient_cash_after_jitter"
			return base
		}
		requiredShares = lotsWithJitter * ipo.SubscriptionLotSize
	}

	// Generate idempotency key
	idemKey := fmt.Sprintf("bot:ipo:%s:%s:v%d", bot.ExternalBotID, ipo.ID, 1)

	priority := "non_event_driven"
	if bot.Strategy == "event_driven" {
		priority = "event_driven"
	}

	base.ShouldSubscribe = true
	base.RequestedShares = requiredShares
	base.IdempotencyKey = idemKey
	base.Reason = fmt.Sprintf("eligible_priority=%s_lots=%d", priority, lotsWithJitter)
	return base
}
