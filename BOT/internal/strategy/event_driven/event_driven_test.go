package eventdriven_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/Mandala-Exchange/bot-v2/internal/client/bei"
	"github.com/Mandala-Exchange/bot-v2/internal/client/mats"
	"github.com/Mandala-Exchange/bot-v2/internal/config"
	"github.com/Mandala-Exchange/bot-v2/internal/portfolio"
	"github.com/Mandala-Exchange/bot-v2/internal/queue"
	"github.com/Mandala-Exchange/bot-v2/internal/registry"
	"github.com/Mandala-Exchange/bot-v2/internal/strategy/event_driven"
)

func createBaseTestConfig() config.EventDrivenConfig {
	return config.EventDrivenConfig{
		InactiveRate:              0.0, // Non-inactive (selalu evaluasi)
		MaxOrdersPerSession:       5,
		MaxLotsPerOrder:           10,
		OpeningAuctionRate:        1.0,
		ClosingAuctionRate:        1.0,
		ContinuousTickIntervalMin: 5,
		ContinuousTickIntervalMax: 15,
	}
}

func createTestBot() *registry.BotInstance {
	bot := registry.NewBotInstance("event-0001", "acc-event-1", "event_driven")
	bot.UpdateFromSnapshot(portfolio.Account{
		AccountID: "acc-event-1",
		Cash: portfolio.Cash{
			AvailableIDR: 50_000_000,
		},
		Positions: []portfolio.Position{
			{
				Symbol:          "MNDL",
				AvailableShares: 5000,
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
			{
				Symbol: "MNDL",
				Status: "listed",
			},
		},
		Rules: ruleProfiles,
	}
}

func TestEventDriven_ReactToPositiveNews(t *testing.T) {
	cfg := createBaseTestConfig()
	strat := eventdriven.New(cfg)

	beiSnap := createBaseTestSnapshot()
	// Gunakan Extreme intensity agar probabilitas reaksi 90% (sangat tinggi)
	beiSnap.News = []bei.News{
		{
			ID:          "news-pos-1",
			Title:       "MNDL Bagikan Dividen Jumbo!",
			Body:        "Dividen MNDL sebesar Rp50 per lembar saham.",
			Symbol:      "MNDL",
			Sentiment:   "positive",
			Intensity:   "extreme",
			PublishedAt: time.Now(),
		},
	}

	matsState := mats.NewMarketState()
	matsState.Signals["MNDL"] = mats.MarketSignal{
		Symbol:    "MNDL",
		LastPrice: 400,
		Open:      400,
	}

	ctx := context.Background()

	// Panggil decide dalam loop max 10x untuk menoleransi RNG roll (90% probabilitas reaksi)
	var decisions []queue.OrderDecision
	for i := 0; i < 10; i++ {
		bot := createTestBot() // buat bot bersih agar ProcessedNewsIDs kosong
		decisions = strat.Decide(ctx, bot, beiSnap, matsState, "continuous")
		if len(decisions) > 0 {
			break
		}
	}

	if len(decisions) != 1 {
		t.Fatalf("Expected 1 decision on positive news, got %d", len(decisions))
	}

	dec := decisions[0]
	if dec.Side != "buy" {
		t.Errorf("Expected side 'buy', got '%s'", dec.Side)
	}
	if dec.Symbol != "MNDL" {
		t.Errorf("Expected symbol 'MNDL', got '%s'", dec.Symbol)
	}
	// MNDL LastPrice = 400. TickSize = 2.
	// Beli agresif = LastPrice + (1 atau 2 Ticks) -> berkisar 402 s/d 404
	if dec.Price < 402 || dec.Price > 404 {
		t.Errorf("Expected price between 402 and 404, got %d", dec.Price)
	}
}

func TestEventDriven_ReactToNegativeNews(t *testing.T) {
	cfg := createBaseTestConfig()
	strat := eventdriven.New(cfg)

	beiSnap := createBaseTestSnapshot()
	beiSnap.News = []bei.News{
		{
			ID:          "news-neg-1",
			Title:       "Gugatan Hukum MNDL Kalah",
			Body:        "MNDL harus membayar denda besar.",
			Symbol:      "MNDL",
			Sentiment:   "negative",
			Intensity:   "extreme",
			PublishedAt: time.Now(),
		},
	}

	matsState := mats.NewMarketState()
	matsState.Signals["MNDL"] = mats.MarketSignal{
		Symbol:    "MNDL",
		LastPrice: 400,
		Open:      400,
	}

	ctx := context.Background()

	var decisions []queue.OrderDecision
	for i := 0; i < 10; i++ {
		bot := createTestBot()
		decisions = strat.Decide(ctx, bot, beiSnap, matsState, "continuous")
		if len(decisions) > 0 {
			break
		}
	}

	if len(decisions) != 1 {
		t.Fatalf("Expected 1 decision on negative news, got %d", len(decisions))
	}

	dec := decisions[0]
	if dec.Side != "sell" {
		t.Errorf("Expected side 'sell', got '%s'", dec.Side)
	}
	if dec.Price < 396 || dec.Price > 398 {
		t.Errorf("Expected price between 396 and 398 (400 - 1 or 2 Ticks), got %d", dec.Price)
	}
}

func TestEventDriven_IgnoreStaleOrProcessedNews(t *testing.T) {
	cfg := createBaseTestConfig()
	strat := eventdriven.New(cfg)

	beiSnap := createBaseTestSnapshot()
	beiSnap.News = []bei.News{
		{
			ID:          "news-processed-1",
			Title:       "MNDL Rilis Produk Baru",
			Symbol:      "MNDL",
			Sentiment:   "positive",
			Intensity:   "extreme",
			PublishedAt: time.Now(),
		},
	}

	matsState := mats.NewMarketState()
	matsState.Signals["MNDL"] = mats.MarketSignal{
		Symbol:    "MNDL",
		LastPrice: 400,
	}

	ctx := context.Background()
	bot := createTestBot()

	// Tandai berita sebagai terproses secara eksplisit
	bot.MarkNewsProcessed("news-processed-1")

	// Panggil decide berkali-kali. Karena news sudah terproses, keputusannya harus tetap nil!
	for i := 0; i < 5; i++ {
		decisions := strat.Decide(ctx, bot, beiSnap, matsState, "continuous")
		if len(decisions) != 0 {
			t.Fatalf("Expected 0 decisions for processed news, got %d", len(decisions))
		}
	}
}

func TestEventDriven_NewsScopeSectorAndGlobal(t *testing.T) {
	cfg := createBaseTestConfig()
	strat := eventdriven.New(cfg)

	beiSnap := createBaseTestSnapshot()
	// Tambah emiten MNDL dengan status listed
	beiSnap.Securities = []bei.Security{
		{Symbol: "MNDL", Status: "listed"},
	}

	// Skenario A: Berita Sektor finance
	beiSnap.News = []bei.News{
		{
			ID:        "news-sector-1",
			Title:     "Sektor Finance Menguat Hari Ini",
			Sector:    "finance",
			Sentiment: "positive",
			Intensity: "extreme",
		},
	}

	matsState := mats.NewMarketState()
	matsState.Signals["MNDL"] = mats.MarketSignal{
		Symbol:    "MNDL",
		LastPrice: 400,
	}

	ctx := context.Background()

	var decisions []queue.OrderDecision
	for i := 0; i < 10; i++ {
		bot := createTestBot()
		decisions = strat.Decide(ctx, bot, beiSnap, matsState, "continuous")
		if len(decisions) > 0 {
			break
		}
	}

	if len(decisions) != 1 {
		t.Fatalf("Expected 1 decision on sector news, got %d", len(decisions))
	}

	// Skenario B: Berita Global (Symbol & Sector kosong)
	beiSnap.News = []bei.News{
		{
			ID:        "news-global-1",
			Title:     "Inflasi Nasional Terkendali",
			Sentiment: "positive",
			Intensity: "extreme",
		},
	}

	decisions = nil
	for i := 0; i < 10; i++ {
		bot := createTestBot()
		decisions = strat.Decide(ctx, bot, beiSnap, matsState, "continuous")
		if len(decisions) > 0 {
			break
		}
	}

	if len(decisions) != 1 {
		t.Fatalf("Expected 1 decision on global news, got %d", len(decisions))
	}
}
