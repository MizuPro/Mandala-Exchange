package indextracker_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/Mandala-Exchange/bot-v2/internal/client/bei"
	"github.com/Mandala-Exchange/bot-v2/internal/client/mats"
	"github.com/Mandala-Exchange/bot-v2/internal/config"
	"github.com/Mandala-Exchange/bot-v2/internal/portfolio"
	"github.com/Mandala-Exchange/bot-v2/internal/registry"
	"github.com/Mandala-Exchange/bot-v2/internal/strategy/index_tracker"
)

func createBaseTestConfig() config.IndexTrackerConfig {
	return config.IndexTrackerConfig{
		InactiveRate:              0.0,
		MaxOrdersPerSession:       1,
		MaxLotsPerOrder:           10,
		OpeningAuctionRate:        0.0,  // Tidak aktif di opening
		ClosingAuctionRate:        1.0,  // Aktif penuh di closing
		ContinuousTickIntervalMin: 10,
		ContinuousTickIntervalMax: 25,
	}
}

func createTestBot(mndlShares, baraShares int64) *registry.BotInstance {
	bot := registry.NewBotInstance("index-0001", "acc-idx-1", "index_tracker")
	bot.UpdateFromSnapshot(portfolio.Account{
		AccountID: "acc-idx-1",
		Cash: portfolio.Cash{
			AvailableIDR: 10_000_000,
		},
		Positions: []portfolio.Position{
			{
				Symbol:          "MNDL",
				AvailableShares: mndlShares,
				AveragePriceIDR: 400,
			},
			{
				Symbol:          "BARA",
				AvailableShares: baraShares,
				AveragePriceIDR: 200,
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
			Status: "closing_auction",
		},
		Securities: []bei.Security{
			{Symbol: "MNDL", Status: "listed"},
			{Symbol: "BARA", Status: "listed"},
		},
		Rules: ruleProfiles,
	}
}

func TestIndexTracker_RebalanceUnderAllocated(t *testing.T) {
	cfg := createBaseTestConfig()
	strat := indextracker.New(cfg)
	beiSnap := createBaseTestSnapshot()

	matsState := mats.NewMarketState()
	matsState.Signals["MNDL"] = mats.MarketSignal{Symbol: "MNDL", LastPrice: 400}
	matsState.Signals["BARA"] = mats.MarketSignal{Symbol: "BARA", LastPrice: 200}

	// Bot punya: Cash = 10JT.
	// MNDL shares = 0 (Value = 0)
	// BARA shares = 100000 (Value = 20JT)
	// Total Portfolio Value = 10JT + 0 + 20JT = 30JT
	// Target per emiten (2 emiten) = 30JT / 2 = 15JT
	// MNDL under-allocated (0 < 15JT) -> Bot harus BUY MNDL
	bot := createTestBot(0, 100000)
	ctx := context.Background()
	decisions := strat.Decide(ctx, bot, beiSnap, matsState, "closing_auction")

	if len(decisions) != 1 {
		t.Fatalf("Expected 1 rebalance decision, got %d", len(decisions))
	}
	if decisions[0].Side != "buy" {
		t.Errorf("Expected side 'buy' for under-allocated MNDL, got '%s'", decisions[0].Side)
	}
	if decisions[0].Symbol != "MNDL" {
		t.Errorf("Expected symbol 'MNDL', got '%s'", decisions[0].Symbol)
	}
}

func TestIndexTracker_RebalanceOverAllocated(t *testing.T) {
	cfg := createBaseTestConfig()
	strat := indextracker.New(cfg)
	beiSnap := createBaseTestSnapshot()

	matsState := mats.NewMarketState()
	matsState.Signals["MNDL"] = mats.MarketSignal{Symbol: "MNDL", LastPrice: 400}
	matsState.Signals["BARA"] = mats.MarketSignal{Symbol: "BARA", LastPrice: 200}

	// Bot punya: Cash = 10JT.
	// MNDL shares = 100000 (Value = 40JT)
	// BARA shares = 0 (Value = 0)
	// Total Portfolio Value = 10JT + 40JT + 0 = 50JT
	// Target per emiten = 25JT
	// MNDL over-allocated (40JT > 25JT) -> Bot harus SELL MNDL
	bot := createTestBot(100000, 0)
	ctx := context.Background()
	decisions := strat.Decide(ctx, bot, beiSnap, matsState, "closing_auction")

	if len(decisions) != 1 {
		t.Fatalf("Expected 1 rebalance decision, got %d", len(decisions))
	}
	if decisions[0].Side != "sell" {
		t.Errorf("Expected side 'sell' for over-allocated MNDL, got '%s'", decisions[0].Side)
	}
	if decisions[0].Symbol != "MNDL" {
		t.Errorf("Expected symbol 'MNDL', got '%s'", decisions[0].Symbol)
	}
}

func TestIndexTracker_InactiveOnOpening(t *testing.T) {
	cfg := createBaseTestConfig()
	strat := indextracker.New(cfg)
	beiSnap := createBaseTestSnapshot()
	// Ganti status session ke opening_auction
	beiSnap.Session.Status = "opening_auction"

	matsState := mats.NewMarketState()
	matsState.Signals["MNDL"] = mats.MarketSignal{Symbol: "MNDL", LastPrice: 400}
	matsState.Signals["BARA"] = mats.MarketSignal{Symbol: "BARA", LastPrice: 200}

	bot := createTestBot(0, 100000)
	ctx := context.Background()
	decisions := strat.Decide(ctx, bot, beiSnap, matsState, "opening_auction")

	// Harus mengembalikan 0 keputusan karena OpeningAuctionRate = 0.0
	if len(decisions) != 0 {
		t.Errorf("Expected 0 decisions in opening auction, got %d", len(decisions))
	}
}
