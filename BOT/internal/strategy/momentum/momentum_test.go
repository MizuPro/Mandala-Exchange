package momentum_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/Mandala-Exchange/bot-v2/internal/client/bei"
	"github.com/Mandala-Exchange/bot-v2/internal/client/mats"
	"github.com/Mandala-Exchange/bot-v2/internal/config"
	"github.com/Mandala-Exchange/bot-v2/internal/portfolio"
	"github.com/Mandala-Exchange/bot-v2/internal/registry"
	"github.com/Mandala-Exchange/bot-v2/internal/strategy/momentum"
)

func createBaseTestSnapshot() bei.Snapshot {
	rulesJSON := json.RawMessage(`[
		{
			"id": "rule-profile-id",
			"name": "Default Rules",
			"board": "main",
			"market_segment": "regular",
			"is_default": true,
			"lot_size_rules": [{"lot_size": 100}],
			"tick_size_rules": [
				{"min_price": "50", "max_price": "200", "tick_size": "1"},
				{"min_price": "200", "max_price": "500", "tick_size": "2"},
				{"min_price": "500", "max_price": "2000", "tick_size": "5"}
			],
			"price_band_rules": [
				{"min_reference_price": "50", "max_reference_price": "200", "ara_percent": "0.35", "arb_percent": "0.35", "min_price": "50"},
				{"min_reference_price": "200", "max_reference_price": "500", "ara_percent": "0.25", "arb_percent": "0.25", "min_price": "50"},
				{"min_reference_price": "500", "max_reference_price": "2000", "ara_percent": "0.20", "arb_percent": "0.20", "min_price": "50"}
			],
			"auto_rejection_rules": [{"max_lots_per_order": 1000}]
		}
	]`)

	var ruleProfiles []bei.TradingRuleProfile
	_ = json.Unmarshal(rulesJSON, &ruleProfiles)

	return bei.Snapshot{
		Securities: []bei.Security{
			{Symbol: "MNDL", Status: "listed"},
		},
		Rules: ruleProfiles,
		FairValues: []bei.FairValue{
			{Symbol: "MNDL", FairValue: 300, Confidence: "medium"},
		},
	}
}

func createTestBot() *registry.BotInstance {
	bot := registry.NewBotInstance("momentum-0001", "acc-momentum-1", "momentum_trader")
	bot.UpdateFromSnapshot(portfolio.Account{
		AccountID: "acc-momentum-1",
		Cash: portfolio.Cash{
			AvailableIDR: 50_000_000,
		},
		Positions: []portfolio.Position{
			{
				Symbol:          "MNDL",
				AvailableShares: 5000, // 50 lot
				AveragePriceIDR: 300,
			},
		},
	})
	return bot
}

func createBaseTestConfig() config.MomentumTraderConfig {
	return config.MomentumTraderConfig{
		InactiveRate:             0.0, // selalu aktif saat dievaluasi
		MaxOrdersPerSession:      3,
		MaxLotsPerOrder:          10,
		SpreadThresholdPct:       0.05,  // 5%
		ImbalanceThreshold:       0.10,  // 10%
		ReturnThreshold:          0.005, // 0.5%
		FairValueBrakeMultiplier: 1.5,
		OpeningAuctionRate:       1.0,
		ClosingAuctionRate:       1.0,
	}
}

func TestMomentum_BuyTrendConfirmed(t *testing.T) {
	cfg := createBaseTestConfig()
	strat := momentum.New(cfg)

	bot := createTestBot()
	beiSnap := createBaseTestSnapshot()

	matsState := mats.NewMarketState()
	// Set signal trend naik kuat terkonfirmasi
	matsState.Signals["MNDL"] = mats.MarketSignal{
		Symbol:             "MNDL",
		LastPrice:          320,
		PreviousPrice:      316,
		ShortReturn:        0.0126, // > 0.5%
		VolumeDelta:        1000,   // Konfirmasi 1
		TradeCountDelta:    15,     // Konfirmasi 2
		OrderBookImbalance: 0.25,   // Konfirmasi 3 (> 10%)
		Spread:             2,      // 2 / 320 = 0.6% <= 5%
		LastUpdatedAt:      time.Now(),
	}

	ctx := context.Background()
	decisions := strat.Decide(ctx, bot, beiSnap, matsState, "continuous")

	if len(decisions) != 1 {
		t.Fatalf("Expected 1 decision, got %d", len(decisions))
	}

	dec := decisions[0]
	if dec.Side != "buy" {
		t.Errorf("Expected side buy, got %s", dec.Side)
	}
	if dec.Price <= 320 {
		t.Errorf("Expected proposed price aggressively higher than LastPrice (320), got %d", dec.Price)
	}
	if dec.Quantity <= 0 {
		t.Errorf("Expected positive quantity, got %d", dec.Quantity)
	}
}

func TestMomentum_SellTrendConfirmed(t *testing.T) {
	cfg := createBaseTestConfig()
	strat := momentum.New(cfg)

	bot := createTestBot()
	beiSnap := createBaseTestSnapshot()

	matsState := mats.NewMarketState()
	// Set signal trend turun kuat terkonfirmasi
	matsState.Signals["MNDL"] = mats.MarketSignal{
		Symbol:             "MNDL",
		LastPrice:          300,
		PreviousPrice:      304,
		ShortReturn:        -0.0131, // < -0.5%
		VolumeDelta:        2000,
		TradeCountDelta:    30,
		OrderBookImbalance: -0.30, // < -10%
		Spread:             2,
		LastUpdatedAt:      time.Now(),
	}

	ctx := context.Background()
	decisions := strat.Decide(ctx, bot, beiSnap, matsState, "continuous")

	if len(decisions) != 1 {
		t.Fatalf("Expected 1 decision, got %d", len(decisions))
	}

	dec := decisions[0]
	if dec.Side != "sell" {
		t.Errorf("Expected side sell, got %s", dec.Side)
	}
	if dec.Price >= 300 {
		t.Errorf("Expected proposed price aggressively lower than LastPrice (300), got %d", dec.Price)
	}
}

func TestMomentum_NoConfirmation(t *testing.T) {
	cfg := createBaseTestConfig()
	strat := momentum.New(cfg)

	bot := createTestBot()
	beiSnap := createBaseTestSnapshot()

	matsState := mats.NewMarketState()
	// Return naik, tapi volume delta = 0, trade delta = 0, imbalance = 0 (hanya 1 konfirmasi)
	matsState.Signals["MNDL"] = mats.MarketSignal{
		Symbol:             "MNDL",
		LastPrice:          320,
		PreviousPrice:      316,
		ShortReturn:        0.0126,
		VolumeDelta:        0,
		TradeCountDelta:    0,
		OrderBookImbalance: 0.0,
		Spread:             2,
		LastUpdatedAt:      time.Now(),
	}

	ctx := context.Background()
	decisions := strat.Decide(ctx, bot, beiSnap, matsState, "continuous")

	if len(decisions) != 0 {
		t.Fatalf("Expected 0 decisions due to lack of confirmations, got %d", len(decisions))
	}
}

func TestMomentum_SafetyBrakeActive(t *testing.T) {
	cfg := createBaseTestConfig()
	cfg.FairValueBrakeMultiplier = 1.1 // set multiplier rendah untuk pengujian brake
	strat := momentum.New(cfg)

	bot := createTestBot()
	beiSnap := createBaseTestSnapshot() // Fair Value MNDL = 300

	matsState := mats.NewMarketState()
	// Harga last 340 (sudah di atas 300 * 1.1 = 330)
	matsState.Signals["MNDL"] = mats.MarketSignal{
		Symbol:             "MNDL",
		LastPrice:          340,
		PreviousPrice:      336,
		ShortReturn:        0.0119,
		VolumeDelta:        1500,
		TradeCountDelta:    20,
		OrderBookImbalance: 0.20,
		Spread:             2,
		LastUpdatedAt:      time.Now(),
	}

	ctx := context.Background()
	decisions := strat.Decide(ctx, bot, beiSnap, matsState, "continuous")

	if len(decisions) != 0 {
		t.Fatalf("Expected 0 decisions because proposed price (agg > 340) violates Fair Value safety brake (330 limit), got %d", len(decisions))
	}
}

func TestMomentum_SpreadTooWide(t *testing.T) {
	cfg := createBaseTestConfig()
	strat := momentum.New(cfg)

	bot := createTestBot()
	beiSnap := createBaseTestSnapshot()

	matsState := mats.NewMarketState()
	// Spread = 20 pada harga 300 (6.67% > 5%)
	matsState.Signals["MNDL"] = mats.MarketSignal{
		Symbol:             "MNDL",
		LastPrice:          300,
		PreviousPrice:      296,
		ShortReturn:        0.0135,
		VolumeDelta:        1000,
		TradeCountDelta:    15,
		OrderBookImbalance: 0.20,
		Spread:             20,
		LastUpdatedAt:      time.Now(),
	}

	ctx := context.Background()
	decisions := strat.Decide(ctx, bot, beiSnap, matsState, "continuous")

	if len(decisions) != 0 {
		t.Fatalf("Expected 0 decisions because spread (6.67%%) is too wide (threshold 5%%), got %d", len(decisions))
	}
}
