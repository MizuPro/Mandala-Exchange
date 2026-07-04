package ipo

import (
	"math/rand"
	"sync"
	"testing"
	"time"

	bei "github.com/Mandala-Exchange/bot-v2/internal/client/bei"
	"github.com/Mandala-Exchange/bot-v2/internal/config"
	"github.com/Mandala-Exchange/bot-v2/internal/portfolio"
	"github.com/Mandala-Exchange/bot-v2/internal/registry"
)

func TestPlan(t *testing.T) {
	cfg := config.IPOConfig{
		MaxCashExposurePct: map[string]float64{
			"event_driven": 0.50, // 50%
			"moderate":     0.10, // 10%
		},
	}
	rng := rand.New(rand.NewSource(1)) // deterministic //nolint:gosec

	now := time.Now()

	validIPO := bei.IPOLifecycle{
		ID:                  "ipo-1",
		Status:              "bookbuilding",
		SubscriptionStart:   now.Add(-1 * time.Hour),
		SubscriptionEnd:     now.Add(1 * time.Hour),
		SubscriptionLotSize: 100,
		OfferingPriceIDR:    100, // Cost per lot = 10000
		IPOArchetype:        "hot_ipo",
	}

	bot := registry.NewBotInstance("bot-1", "acc-1", "event_driven")
	bot.SetStatus("active")
	// 50% * 1.0 = 50% max exposure -> 50,000 cash for IPO -> 5 lots
	bot.UpdateFromSnapshot(mockSnapshot("acc-1", 100000))

	t.Run("EventDrivenPriority", func(t *testing.T) {
		dec := Plan(bot, validIPO, cfg, rng)
		if !dec.ShouldSubscribe {
			t.Errorf("expected subscribe, reason: %s", dec.Reason)
		}
		// Lots affordable = 50,000 / 10000 = 5
		// Jitter 0.85-1.15 applied to 5. With seed=1 -> lets just check it's > 0
		if dec.RequestedShares < 100 {
			t.Errorf("expected at least 1 lot")
		}
	})

	t.Run("NonEventDrivenPriority", func(t *testing.T) {
		bot2 := registry.NewBotInstance("bot-2", "acc-2", "moderate")
		bot2.SetStatus("active")
		bot2.UpdateFromSnapshot(mockSnapshot("acc-2", 100000))
		// 10% * 0.5 = 5% max exposure -> 5,000 cash for IPO -> 0 lots (1 lot is 10000)
		dec := Plan(bot2, validIPO, cfg, rng)
		if dec.ShouldSubscribe {
			t.Errorf("expected NO subscribe due to insufficient cash after multiplier")
		}
	})

	t.Run("WindowClosed", func(t *testing.T) {
		closedIPO := validIPO
		closedIPO.SubscriptionEnd = now.Add(-1 * time.Minute)
		dec := Plan(bot, closedIPO, cfg, rng)
		if dec.ShouldSubscribe {
			t.Errorf("expected NO subscribe due to window closed")
		}
	})

	t.Run("OverpricedBlocked", func(t *testing.T) {
		overpricedIPO := validIPO
		overpricedIPO.IPOArchetype = "overpriced_ipo"
		overpricedIPO.FairValueInitial = 80 // 10% over fair value = 88. Offering = 100.
		// Event driven should still subscribe
		dec := Plan(bot, overpricedIPO, cfg, rng)
		if !dec.ShouldSubscribe {
			t.Errorf("event_driven should subscribe overpriced, reason: %s", dec.Reason)
		}

		botMod := registry.NewBotInstance("bot-mod", "acc-mod", "moderate")
		botMod.SetStatus("active")
		botMod.UpdateFromSnapshot(mockSnapshot("acc-mod", 1000000)) // enough cash
		decMod := Plan(botMod, overpricedIPO, cfg, rng)
		if decMod.ShouldSubscribe {
			t.Errorf("moderate bot should NOT subscribe overpriced")
		}
	})
}

func TestIPORegistryConcurrency(t *testing.T) {
	reg := NewIPORegistry()
	var wg sync.WaitGroup

	// Test concurrent Upsert and Get
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			ipo := bei.IPOLifecycle{
				ID:      "ipo-concurrent",
				Version: idx,
				Status:  "bookbuilding",
			}
			reg.Upsert(ipo)
			reg.Get("ipo-concurrent")
			reg.All()
			reg.MarkProcessed("ipo-concurrent", idx)
		}(i)
	}
	wg.Wait()

	entry, ok := reg.Get("ipo-concurrent")
	if !ok {
		t.Fatalf("expected entry to exist")
	}
	if entry.ProcessedVersion == -1 {
		t.Fatalf("expected processed version to be updated")
	}
}

// Helper mock
func mockSnapshot(accountID string, cash int64) portfolio.Account {
	return portfolio.Account{
		AccountID: accountID,
		Cash: portfolio.Cash{
			AvailableIDR: cash,
		},
	}
}
