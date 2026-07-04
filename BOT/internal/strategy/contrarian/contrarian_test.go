package contrarian_test

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
	"github.com/Mandala-Exchange/bot-v2/internal/strategy/contrarian"
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
			{Symbol: "MNDL", FairValue: 400, Confidence: "medium"}, // Fair value 400
		},
	}
}

func createTestBot() *registry.BotInstance {
	bot := registry.NewBotInstance("contrarian-0001", "acc-contrarian-1", "contrarian")
	bot.UpdateFromSnapshot(portfolio.Account{
		AccountID: "acc-contrarian-1",
		Cash: portfolio.Cash{
			AvailableIDR: 50_000_000,
		},
		Positions: []portfolio.Position{
			{
				Symbol:          "MNDL",
				AvailableShares: 6000, // 60 lot
				AveragePriceIDR: 400,
			},
		},
	})
	return bot
}

func createBaseTestConfig() config.ContrarianConfig {
	return config.ContrarianConfig{
		InactiveRate:               0.0,
		MaxOrdersPerSession:        2,
		MaxLotsPerOrder:            10,
		DiscountThreshold:          0.10, // diskon 10% dari Fair Value
		PremiumThreshold:           0.10, // premium 10% dari Fair Value
		ReferenceDeviationThreshold: 0.05, // 5% deviasi dari Open/Prev Close
		OpeningAuctionRate:         1.0,
		ClosingAuctionRate:         1.0,
	}
}

func TestContrarian_BuyOnDiscount(t *testing.T) {
	cfg := createBaseTestConfig()
	strat := contrarian.New(cfg)

	bot := createTestBot()
	beiSnap := createBaseTestSnapshot()

	matsState := mats.NewMarketState()
	// Open harga 400, Last 350. Deviasi: (400-350)/400 = 12.5% (> 5%)
	// Fair Value 400. Batas diskon 10% = 360. Last 350 <= 360 (Diskon!)
	// ShortReturn perlambatan: -0.005 (tidak jatuh terlalu tajam, > -0.02)
	matsState.Signals["MNDL"] = mats.MarketSignal{
		Symbol:        "MNDL",
		LastPrice:     350,
		PreviousPrice: 352,
		ShortReturn:   -0.0057,
		Open:          400,
		LastUpdatedAt: time.Now(),
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
	if dec.Price >= 350 {
		t.Errorf("Expected proposed price passively lower than LastPrice (350), got %d", dec.Price)
	}
}

func TestContrarian_SellOnPremium(t *testing.T) {
	cfg := createBaseTestConfig()
	strat := contrarian.New(cfg)

	bot := createTestBot()
	beiSnap := createBaseTestSnapshot()

	matsState := mats.NewMarketState()
	// Open harga 400, Last 450. Deviasi: (450-400)/400 = 12.5% (> 5%)
	// Fair Value 400. Batas premium 10% = 440. Last 450 >= 440 (Premium!)
	// ShortReturn perlambatan: 0.004 (tidak naik terlalu tajam, < 0.02)
	matsState.Signals["MNDL"] = mats.MarketSignal{
		Symbol:        "MNDL",
		LastPrice:     450,
		PreviousPrice: 448,
		ShortReturn:   0.0045,
		Open:          400,
		LastUpdatedAt: time.Now(),
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
	if dec.Price <= 450 {
		t.Errorf("Expected proposed price passively higher than LastPrice (450), got %d", dec.Price)
	}
}

func TestContrarian_NewsBlockBuy(t *testing.T) {
	cfg := createBaseTestConfig()
	strat := contrarian.New(cfg)

	bot := createTestBot()
	beiSnap := createBaseTestSnapshot()
	// Tambahkan bad news tentang MNDL
	beiSnap.News = []bei.News{
		{
			Title:       "MNDL Financial Crisis",
			Body:        "MNDL is experiencing severe liquidity issues",
			Symbol:      "MNDL",
			Sentiment:   "negative",
			Intensity:   "high",
			PublishedAt: time.Now(),
		},
	}

	matsState := mats.NewMarketState()
	// Last 350 <= 360 (Diskon dari Fair Value 400)
	matsState.Signals["MNDL"] = mats.MarketSignal{
		Symbol:        "MNDL",
		LastPrice:     350,
		PreviousPrice: 352,
		ShortReturn:   -0.0057,
		Open:          400,
		LastUpdatedAt: time.Now(),
	}

	ctx := context.Background()
	decisions := strat.Decide(ctx, bot, beiSnap, matsState, "continuous")

	if len(decisions) != 0 {
		t.Fatalf("Expected 0 decisions because BUY should be blocked by high negative news, got %d", len(decisions))
	}
}

func TestContrarian_StepEntry(t *testing.T) {
	cfg := createBaseTestConfig()
	cfg.MaxLotsPerOrder = 100 // Set max lot order tinggi agar clamp scaledLots yang bekerja
	strat := contrarian.New(cfg)

	bot := registry.NewBotInstance("contrarian-0001", "acc-contrarian-1", "contrarian")
	bot.UpdateFromSnapshot(portfolio.Account{
		AccountID: "acc-contrarian-1",
		Cash: portfolio.Cash{
			AvailableIDR: 1_500_000, // Cash kecil agar limit 1/3 terasa
		},
		Positions: []portfolio.Position{
			{
				Symbol:          "MNDL",
				AvailableShares: 6000,
				AveragePriceIDR: 400,
			},
		},
	})
	beiSnap := createBaseTestSnapshot()

	matsState := mats.NewMarketState()
	matsState.Signals["MNDL"] = mats.MarketSignal{
		Symbol:        "MNDL",
		LastPrice:     350,
		PreviousPrice: 352,
		ShortReturn:   -0.0057,
		Open:          400,
		LastUpdatedAt: time.Now(),
	}

	ctx := context.Background()
	decisions := strat.Decide(ctx, bot, beiSnap, matsState, "continuous")

	if len(decisions) != 1 {
		t.Fatalf("Expected 1 decision, got %d", len(decisions))
	}

	dec := decisions[0]
	// Max total affordable = 1.500.000 / (346 * 100) = 43 s/d 45 lot.
	// Max scaled lots (1/3) = 14 s/d 15 lot.
	maxExpectedQty := int64(15 * 100)
	if dec.Quantity <= 0 || dec.Quantity > maxExpectedQty {
		t.Errorf("Expected quantity cicilan <= %d and > 0, got %d", maxExpectedQty, dec.Quantity)
	}
}
