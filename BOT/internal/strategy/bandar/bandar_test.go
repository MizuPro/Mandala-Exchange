package bandar_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/Mandala-Exchange/bot-v2/internal/client/bei"
	"github.com/Mandala-Exchange/bot-v2/internal/client/mats"
	"github.com/Mandala-Exchange/bot-v2/internal/config"
	"github.com/Mandala-Exchange/bot-v2/internal/portfolio"
	"github.com/Mandala-Exchange/bot-v2/internal/registry"
	"github.com/Mandala-Exchange/bot-v2/internal/strategy/bandar"
)

func createBaseTestConfig() config.BandarConfig {
	return config.BandarConfig{
		InactiveRate:             0.0,
		MaxOrdersPerSession:      2,
		MaxLotsPerOrder:          50,
		FairValueBrakeMultiplier: 1.5,
		BrakeDiscount:             0.50,
		OpeningAuctionRate:        1.0,
		ClosingAuctionRate:        1.0,
		ContinuousTickIntervalMin: 10,
		ContinuousTickIntervalMax: 25,
	}
}

func createTestBot(shares int64, cash int64) *registry.BotInstance {
	bot := registry.NewBotInstance("bandar-0001", "acc-ban-1", "bandar")
	bot.UpdateFromSnapshot(portfolio.Account{
		AccountID: "acc-ban-1",
		Cash: portfolio.Cash{
			AvailableIDR: cash,
		},
		Positions: []portfolio.Position{
			{
				Symbol:          "MNDL",
				AvailableShares: shares,
				AveragePriceIDR: 400,
			},
		},
	})
	return bot
}

func createBaseTestSnapshot() bei.Snapshot {
	rulesJSON := json.RawMessage(`[
		{
			"id": "rule-profile-id",
			"name": "Default Rules",
			"board": "main",
			"market_segment": "regular",
			"is_default": true,
			"lot_size_rules": [{"lot_size": 100}],
			"tick_size_rules": [{"min_price": "50", "max_price": "2000", "tick_size": "2"}],
			"price_band_rules": [{"min_reference_price": "50", "max_reference_price": "2000", "ara_percent": "0.25", "arb_percent": "0.25", "min_price": "50"}],
			"auto_rejection_rules": [{"max_lots_per_order": 1000}]
		}
	]`)

	var ruleProfiles []bei.TradingRuleProfile
	_ = json.Unmarshal(rulesJSON, &ruleProfiles)

	return bei.Snapshot{
		Session: &bei.SessionState{
			ID:     "test-session",
			Status: "continuous",
		},
		Securities: []bei.Security{
			{Symbol: "MNDL", Status: "listed"},
		},
		FairValues: []bei.FairValue{
			{Symbol: "MNDL", FairValue: 400}, // Fair Value 400
		},
		Rules: ruleProfiles,
	}
}

func TestBandar_BuyBrake(t *testing.T) {
	cfg := createBaseTestConfig()
	strat := bandar.New(cfg)
	beiSnap := createBaseTestSnapshot()

	// MNDL LastPrice = 610 -> di atas Fair Value 400 * 1.5 BrakeMultiplier = 600
	matsState := mats.NewMarketState()
	matsState.Signals["MNDL"] = mats.MarketSignal{
		Symbol:    "MNDL",
		LastPrice: 610,
	}

	bot := createTestBot(0, 50_000_000)
	ctx := context.Background()

	// Lakukan loop test 50x karena arah transaksi Bandar acak (isBuy 50%)
	// Jika BUY terpicu, dia harus di-brake (mengembalikan 0 keputusan)
	for i := 0; i < 50; i++ {
		decisions := strat.Decide(ctx, bot, beiSnap, matsState, "continuous")
		for _, dec := range decisions {
			if dec.Side == "buy" {
				t.Errorf("Self-Trade Brake failed: Bandar bought MNDL at 610, exceeding limit price 600")
			}
		}
	}
}

func TestBandar_SellBrake(t *testing.T) {
	cfg := createBaseTestConfig()
	strat := bandar.New(cfg)
	beiSnap := createBaseTestSnapshot()

	// MNDL LastPrice = 190 -> di bawah Fair Value 400 * (1 - 0.5) BrakeDiscount = 200
	matsState := mats.NewMarketState()
	matsState.Signals["MNDL"] = mats.MarketSignal{
		Symbol:    "MNDL",
		LastPrice: 190,
	}

	bot := createTestBot(5000, 50_000_000)
	ctx := context.Background()

	for i := 0; i < 50; i++ {
		decisions := strat.Decide(ctx, bot, beiSnap, matsState, "continuous")
		for _, dec := range decisions {
			if dec.Side == "sell" {
				t.Errorf("Self-Trade Brake failed: Bandar sold MNDL at 190, below limit price 200")
			}
		}
	}
}

func TestBandar_LargeLots(t *testing.T) {
	cfg := createBaseTestConfig()
	strat := bandar.New(cfg)
	beiSnap := createBaseTestSnapshot()

	matsState := mats.NewMarketState()
	matsState.Signals["MNDL"] = mats.MarketSignal{
		Symbol:    "MNDL",
		LastPrice: 400,
	}

	bot := createTestBot(5000, 50_000_000)
	ctx := context.Background()

	hasLargeLots := false
	for i := 0; i < 50; i++ {
		decisions := strat.Decide(ctx, bot, beiSnap, matsState, "continuous")
		if len(decisions) == 1 {
			qtyLots := decisions[0].Quantity / 100
			if qtyLots >= 20 {
				hasLargeLots = true
				break
			}
		}
	}

	if !hasLargeLots {
		t.Errorf("Bandar strategy did not submit large lots order (>= 20 lots) in 50 trials")
	}
}
