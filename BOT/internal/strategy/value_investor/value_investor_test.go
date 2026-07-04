package valueinvestor_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/Mandala-Exchange/bot-v2/internal/client/bei"
	"github.com/Mandala-Exchange/bot-v2/internal/client/mats"
	"github.com/Mandala-Exchange/bot-v2/internal/config"
	"github.com/Mandala-Exchange/bot-v2/internal/portfolio"
	"github.com/Mandala-Exchange/bot-v2/internal/registry"
	"github.com/Mandala-Exchange/bot-v2/internal/strategy/value_investor"
)

func createBaseTestConfig() config.ValueInvestorConfig {
	return config.ValueInvestorConfig{
		InactiveRate:              0.0,
		MaxOrdersPerSession:       1,
		MaxLotsPerOrder:           5,
		DiscountThreshold:         0.15, // MOS 15%
		PremiumThreshold:          0.15, // Premium 15%
		OpeningAuctionRate:        1.0,
		ClosingAuctionRate:        1.0,
		ContinuousTickIntervalMin: 10,
		ContinuousTickIntervalMax: 25,
	}
}

func createTestBot(shares int64, ordersCount int, sessionID string) *registry.BotInstance {
	bot := registry.NewBotInstance("value-0001", "acc-val-1", "value_investor")
	bot.UpdateFromSnapshot(portfolio.Account{
		AccountID: "acc-val-1",
		Cash: portfolio.Cash{
			AvailableIDR: 50_000_000,
		},
		Positions: []portfolio.Position{
			{
				Symbol:          "MNDL",
				AvailableShares: shares,
				AveragePriceIDR: 400,
			},
		},
	})
	if ordersCount > 0 {
		for i := 0; i < ordersCount; i++ {
			bot.AddOrderCount(sessionID)
		}
	}
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

func TestValueInvestor_BuyUnderFairValue(t *testing.T) {
	cfg := createBaseTestConfig()
	strat := valueinvestor.New(cfg)
	beiSnap := createBaseTestSnapshot()

	// MNDL LastPrice = 330 (di bawah Fair Value 400 - 15% MOS = 340)
	matsState := mats.NewMarketState()
	matsState.Signals["MNDL"] = mats.MarketSignal{
		Symbol:    "MNDL",
		LastPrice: 330,
	}

	bot := createTestBot(0, 0, "")
	ctx := context.Background()
	decisions := strat.Decide(ctx, bot, beiSnap, matsState, "continuous")

	if len(decisions) != 1 {
		t.Fatalf("Expected 1 buy decision, got %d", len(decisions))
	}
	if decisions[0].Side != "buy" {
		t.Errorf("Expected side 'buy', got '%s'", decisions[0].Side)
	}
	if decisions[0].Price != 330 {
		t.Errorf("Expected price 330, got %d", decisions[0].Price)
	}
}

func TestValueInvestor_SellAboveFairValue(t *testing.T) {
	cfg := createBaseTestConfig()
	strat := valueinvestor.New(cfg)
	beiSnap := createBaseTestSnapshot()

	// MNDL LastPrice = 470 (di atas Fair Value 400 + 15% Premium = 460)
	matsState := mats.NewMarketState()
	matsState.Signals["MNDL"] = mats.MarketSignal{
		Symbol:    "MNDL",
		LastPrice: 470,
	}

	bot := createTestBot(1000, 0, "") // punya saham 1000
	ctx := context.Background()
	decisions := strat.Decide(ctx, bot, beiSnap, matsState, "continuous")

	if len(decisions) != 1 {
		t.Fatalf("Expected 1 sell decision, got %d", len(decisions))
	}
	if decisions[0].Side != "sell" {
		t.Errorf("Expected side 'sell', got '%s'", decisions[0].Side)
	}
	if decisions[0].Price != 470 {
		t.Errorf("Expected price 470, got %d", decisions[0].Price)
	}
}

func TestValueInvestor_MaxOrdersLimit(t *testing.T) {
	cfg := createBaseTestConfig()
	strat := valueinvestor.New(cfg)
	beiSnap := createBaseTestSnapshot()

	matsState := mats.NewMarketState()
	matsState.Signals["MNDL"] = mats.MarketSignal{
		Symbol:    "MNDL",
		LastPrice: 300,
	}

	// Sesi segment continuous, bot sudah mengirim 1 order di sesi "test-session" ini
	bot := createTestBot(0, 1, "test-session")
	ctx := context.Background()
	decisions := strat.Decide(ctx, bot, beiSnap, matsState, "continuous")

	// Harus mengembalikan 0 keputusan karena max orders limit tercapai
	if len(decisions) != 0 {
		t.Errorf("Expected 0 decisions due to order limit, got %d", len(decisions))
	}
}
