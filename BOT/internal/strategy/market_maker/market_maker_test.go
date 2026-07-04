package marketmaker_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/Mandala-Exchange/bot-v2/internal/client/bei"
	"github.com/Mandala-Exchange/bot-v2/internal/client/mats"
	"github.com/Mandala-Exchange/bot-v2/internal/config"
	"github.com/Mandala-Exchange/bot-v2/internal/portfolio"
	"github.com/Mandala-Exchange/bot-v2/internal/registry"
	"github.com/Mandala-Exchange/bot-v2/internal/strategy/market_maker"
)

func createBaseTestConfig() config.MarketMakerConfig {
	return config.MarketMakerConfig{
		InactiveRate:              0.0,
		MaxOrdersPerSession:       6,
		MaxLotsPerOrder:           10,
		BaseSpreadTicks:           4,
		MaxInventoryShares:        5000,
		OpeningAuctionRate:        1.0,
		ClosingAuctionRate:        1.0,
		ContinuousTickIntervalMin: 10,
		ContinuousTickIntervalMax: 25,
	}
}

func createTestBot(shares int64) *registry.BotInstance {
	bot := registry.NewBotInstance("mm-0001", "acc-mm-1", "market_maker")
	bot.UpdateFromSnapshot(portfolio.Account{
		AccountID: "acc-mm-1",
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
	}
}

func TestMarketMaker_QuoteBidAsk(t *testing.T) {
	cfg := createBaseTestConfig()
	strat := marketmaker.New(cfg)

	bot := createTestBot(1000) // punya inventory 1000 shares
	beiSnap := createBaseTestSnapshot()

	matsState := mats.NewMarketState()
	matsState.Signals["MNDL"] = mats.MarketSignal{
		Symbol:    "MNDL",
		LastPrice: 400,
	}
	matsState.BestBids["MNDL"] = "398"
	matsState.BestAsks["MNDL"] = "402"

	ctx := context.Background()
	decisions := strat.Decide(ctx, bot, beiSnap, matsState, "continuous")

	if len(decisions) != 2 {
		t.Fatalf("Expected 2 decisions (1 bid, 1 ask), got %d", len(decisions))
	}

	var hasBuy, hasSell bool
	for _, dec := range decisions {
		if dec.Side == "buy" {
			hasBuy = true
			// Mid = 400. Tick = 2. BaseSpread = 4.
			// BidPrice = Mid - (4/2)*2 = 400 - 4 = 396
			if dec.Price != 396 {
				t.Errorf("Expected bid price 396, got %d", dec.Price)
			}
		} else if dec.Side == "sell" {
			hasSell = true
			// AskPrice = Mid + (4/2)*2 = 400 + 4 = 404
			if dec.Price != 404 {
				t.Errorf("Expected ask price 404, got %d", dec.Price)
			}
		}
	}

	if !hasBuy || !hasSell {
		t.Errorf("Expected both buy and sell quotes, got buy=%t, sell=%t", hasBuy, hasSell)
	}
}

func TestMarketMaker_InventoryLimit(t *testing.T) {
	cfg := createBaseTestConfig()
	strat := marketmaker.New(cfg)
	beiSnap := createBaseTestSnapshot()
	matsState := mats.NewMarketState()
	matsState.BestBids["MNDL"] = "398"
	matsState.BestAsks["MNDL"] = "402"
	ctx := context.Background()

	// Skenario A: Saham penuh (>= 5000)
	botFull := createTestBot(5500)
	decisionsA := strat.Decide(ctx, botFull, beiSnap, matsState, "continuous")

	// Harus hanya menaruh quote SELL (1 order)
	if len(decisionsA) != 1 {
		t.Fatalf("Expected 1 decision on full inventory, got %d", len(decisionsA))
	}
	if decisionsA[0].Side != "sell" {
		t.Errorf("Expected side 'sell' when inventory is full, got '%s'", decisionsA[0].Side)
	}

	// Skenario B: Saham kosong (0)
	botEmpty := createTestBot(0)
	decisionsB := strat.Decide(ctx, botEmpty, beiSnap, matsState, "continuous")

	// Harus hanya menaruh quote BUY (1 order)
	if len(decisionsB) != 1 {
		t.Fatalf("Expected 1 decision on empty inventory, got %d", len(decisionsB))
	}
	if decisionsB[0].Side != "buy" {
		t.Errorf("Expected side 'buy' when inventory is empty, got '%s'", decisionsB[0].Side)
	}
}

func TestMarketMaker_WideningSpreadOnHighNews(t *testing.T) {
	cfg := createBaseTestConfig()
	strat := marketmaker.New(cfg)

	beiSnap := createBaseTestSnapshot()
	// Tambah berita High
	beiSnap.News = []bei.News{
		{
			ID:        "news-high-1",
			Title:     "Perkembangan Positif MNDL",
			Symbol:    "MNDL",
			Intensity: "high",
			Sentiment: "positive",
		},
	}

	bot := createTestBot(1000)
	matsState := mats.NewMarketState()
	matsState.BestBids["MNDL"] = "398"
	matsState.BestAsks["MNDL"] = "402"

	ctx := context.Background()
	decisions := strat.Decide(ctx, bot, beiSnap, matsState, "continuous")

	if len(decisions) != 2 {
		t.Fatalf("Expected 2 decisions, got %d", len(decisions))
	}

	// Spread ticks dilipatgandakan dari 4 menjadi 8ticks.
	// Mid = 400. Tick = 2.
	// Bid = 400 - (8/2)*2 = 400 - 8 = 392
	// Ask = 400 + (8/2)*2 = 400 + 8 = 408
	for _, dec := range decisions {
		if dec.Side == "buy" {
			if dec.Price != 392 {
				t.Errorf("Expected widened bid price 392, got %d", dec.Price)
			}
		} else if dec.Side == "sell" {
			if dec.Price != 408 {
				t.Errorf("Expected widened ask price 408, got %d", dec.Price)
			}
		}
	}
}

func TestMarketMaker_WithdrawOnExtremeNews(t *testing.T) {
	cfg := createBaseTestConfig()
	strat := marketmaker.New(cfg)

	beiSnap := createBaseTestSnapshot()
	// Tambah berita Extreme
	beiSnap.News = []bei.News{
		{
			ID:        "news-extreme-1",
			Title:     "Kejadian Luar Biasa MNDL!",
			Symbol:    "MNDL",
			Intensity: "extreme",
			Sentiment: "negative",
		},
	}

	bot := createTestBot(1000)
	matsState := mats.NewMarketState()
	matsState.BestBids["MNDL"] = "398"
	matsState.BestAsks["MNDL"] = "402"

	ctx := context.Background()
	decisions := strat.Decide(ctx, bot, beiSnap, matsState, "continuous")

	// Harus mengembalikan 0 keputusan karena quote di-withdraw
	if len(decisions) != 0 {
		t.Errorf("Expected 0 decisions (withdrawn quote) on extreme news, got %d", len(decisions))
	}
}

func TestMarketMaker_SelfTradePrevention(t *testing.T) {
	cfg := createBaseTestConfig()
	cfg.BaseSpreadTicks = 0 // set spread tick ke 0 untuk mengetes clamping ask > bid
	strat := marketmaker.New(cfg)

	bot := createTestBot(1000)
	beiSnap := createBaseTestSnapshot()

	matsState := mats.NewMarketState()
	matsState.BestBids["MNDL"] = "400"
	matsState.BestAsks["MNDL"] = "400"

	ctx := context.Background()
	decisions := strat.Decide(ctx, bot, beiSnap, matsState, "continuous")

	if len(decisions) != 2 {
		t.Fatalf("Expected 2 decisions, got %d", len(decisions))
	}

	var bidPrice, askPrice int64
	for _, dec := range decisions {
		if dec.Side == "buy" {
			bidPrice = dec.Price
		} else if dec.Side == "sell" {
			askPrice = dec.Price
		}
	}

	if bidPrice >= askPrice {
		t.Errorf("Self-Trade Prevention failed: Bid price %d must be lower than Ask price %d", bidPrice, askPrice)
	}
}
