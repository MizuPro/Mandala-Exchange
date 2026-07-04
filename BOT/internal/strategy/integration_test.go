package strategy_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/Mandala-Exchange/bot-v2/internal/client/bei"
	"github.com/Mandala-Exchange/bot-v2/internal/client/mats"
	"github.com/Mandala-Exchange/bot-v2/internal/config"
	"github.com/Mandala-Exchange/bot-v2/internal/portfolio"
	"github.com/Mandala-Exchange/bot-v2/internal/queue"
	"github.com/Mandala-Exchange/bot-v2/internal/registry"
	"github.com/Mandala-Exchange/bot-v2/internal/runner"
	"github.com/Mandala-Exchange/bot-v2/internal/scheduler"
	"github.com/Mandala-Exchange/bot-v2/internal/strategy"
	"github.com/Mandala-Exchange/bot-v2/internal/strategy/bandar"
	"github.com/Mandala-Exchange/bot-v2/internal/strategy/contrarian"
	"github.com/Mandala-Exchange/bot-v2/internal/strategy/event_driven"
	"github.com/Mandala-Exchange/bot-v2/internal/strategy/index_tracker"
	"github.com/Mandala-Exchange/bot-v2/internal/strategy/market_maker"
	"github.com/Mandala-Exchange/bot-v2/internal/strategy/momentum"
	"github.com/Mandala-Exchange/bot-v2/internal/strategy/noise"
	"github.com/Mandala-Exchange/bot-v2/internal/strategy/value_investor"
)

func createTestRules() json.RawMessage {
	return json.RawMessage(`[
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
}

func TestMultiStrategyIntegration_NeutralMarket(t *testing.T) {
	// Mock Server untuk BEI session-state & reference data
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/bot/session-state":
			_, _ = w.Write([]byte(`{"id":"session-4b-test","status":"continuous"}`))
		case "/bot/trading-rules":
			_, _ = w.Write(createTestRules())
		case "/bot/fee-schedule":
			_, _ = w.Write([]byte(`[]`))
		case "/bot/daftar-saham-aktif":
			_, _ = w.Write([]byte(`[{"symbol":"MNDL","board":"main","status":"listed"}]`))
		case "/bot/news-module":
			_, _ = w.Write([]byte(`[
				{"id":"news-1","title":"MNDL Laba Bersih Naik 50%","symbol":"MNDL","sentiment":"positive","intensity":"high"},
				{"id":"news-2","title":"Koreksi Pasar MNDL","symbol":"MNDL","sentiment":"negative","intensity":"medium"}
			]`))
		case "/bot/fair-value-module":
			_, _ = w.Write([]byte(`[{"symbol":"MNDL","fair_value":400,"confidence":"medium"}]`))
		default:
			_, _ = w.Write([]byte(`null`))
		}
	}))
	defer server.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	beiClient := bei.NewClient(server.URL, "test-token")
	if _, err := beiClient.PollSessionState(ctx); err != nil {
		t.Fatal(err)
	}
	if err := beiClient.PollAllState(ctx); err != nil {
		t.Fatal(err)
	}

	matsClient := mats.NewClient("ws://example.invalid", "", []string{"MNDL"})
	matsState := matsClient.GetState()

	// Update signal di MatsState
	matsState.Signals["MNDL"] = mats.MarketSignal{
		Symbol:             "MNDL",
		LastPrice:          350,
		PreviousPrice:      352,
		ShortReturn:        -0.0057,
		Open:               400,
		Spread:             2,
		VolumeDelta:        1000,
		TradeCountDelta:    15,
		OrderBookImbalance: 0.15,
		LastUpdatedAt:      time.Now(),
	}

	reg := registry.NewRegistry()

	// Register 100 Bot: 32 Noise, 18 Momentum, 14 Contrarian, 12 Event, 8 Market Maker, 8 Value, 4 Index, 4 Bandar
	var bots []*registry.BotInstance
	for i := 1; i <= 32; i++ {
		botID := fmt.Sprintf("noise-%04d", i)
		accID := "acc-" + botID
		b := reg.Register(botID, accID, "noise_trader")
		b.UpdateFromSnapshot(portfolio.Account{
			AccountID: accID,
			Cash:      portfolio.Cash{AvailableIDR: 10_000_000},
			Positions: []portfolio.Position{{Symbol: "MNDL", AvailableShares: 500, AveragePriceIDR: 350}},
		})
		bots = append(bots, b)
	}

	for i := 1; i <= 18; i++ {
		botID := fmt.Sprintf("momentum-%04d", i)
		accID := "acc-" + botID
		b := reg.Register(botID, accID, "momentum_trader")
		b.UpdateFromSnapshot(portfolio.Account{
			AccountID: accID,
			Cash:      portfolio.Cash{AvailableIDR: 20_000_000},
			Positions: []portfolio.Position{{Symbol: "MNDL", AvailableShares: 1000, AveragePriceIDR: 350}},
		})
		bots = append(bots, b)
	}

	for i := 1; i <= 14; i++ {
		botID := fmt.Sprintf("contrarian-%04d", i)
		accID := "acc-" + botID
		b := reg.Register(botID, accID, "contrarian")
		b.UpdateFromSnapshot(portfolio.Account{
			AccountID: accID,
			Cash:      portfolio.Cash{AvailableIDR: 30_000_000},
			Positions: []portfolio.Position{{Symbol: "MNDL", AvailableShares: 1500, AveragePriceIDR: 350}},
		})
		bots = append(bots, b)
	}

	for i := 1; i <= 12; i++ {
		botID := fmt.Sprintf("event-%04d", i)
		accID := "acc-" + botID
		b := reg.Register(botID, accID, "event_driven")
		b.UpdateFromSnapshot(portfolio.Account{
			AccountID: accID,
			Cash:      portfolio.Cash{AvailableIDR: 25_000_000},
			Positions: []portfolio.Position{{Symbol: "MNDL", AvailableShares: 1200, AveragePriceIDR: 350}},
		})
		bots = append(bots, b)
	}

	for i := 1; i <= 8; i++ {
		botID := fmt.Sprintf("mm-%04d", i)
		accID := "acc-" + botID
		b := reg.Register(botID, accID, "market_maker")
		b.UpdateFromSnapshot(portfolio.Account{
			AccountID: accID,
			Cash:      portfolio.Cash{AvailableIDR: 40_000_000},
			Positions: []portfolio.Position{{Symbol: "MNDL", AvailableShares: 2000, AveragePriceIDR: 350}},
		})
		bots = append(bots, b)
	}

	for i := 1; i <= 8; i++ {
		botID := fmt.Sprintf("value-%04d", i)
		accID := "acc-" + botID
		b := reg.Register(botID, accID, "value_investor")
		b.UpdateFromSnapshot(portfolio.Account{
			AccountID: accID,
			Cash:      portfolio.Cash{AvailableIDR: 100_000_000},
			Positions: []portfolio.Position{{Symbol: "MNDL", AvailableShares: 2500, AveragePriceIDR: 350}},
		})
		bots = append(bots, b)
	}

	for i := 1; i <= 4; i++ {
		botID := fmt.Sprintf("index-%04d", i)
		accID := "acc-" + botID
		b := reg.Register(botID, accID, "index_tracker")
		b.UpdateFromSnapshot(portfolio.Account{
			AccountID: accID,
			Cash:      portfolio.Cash{AvailableIDR: 200_000_000},
			Positions: []portfolio.Position{{Symbol: "MNDL", AvailableShares: 3000, AveragePriceIDR: 350}},
		})
		bots = append(bots, b)
	}

	for i := 1; i <= 4; i++ {
		botID := fmt.Sprintf("bandar-%04d", i)
		accID := "acc-" + botID
		b := reg.Register(botID, accID, "bandar")
		b.UpdateFromSnapshot(portfolio.Account{
			AccountID: accID,
			Cash:      portfolio.Cash{AvailableIDR: 1_000_000_000},
			Positions: []portfolio.Position{{Symbol: "MNDL", AvailableShares: 10000, AveragePriceIDR: 350}},
		})
		bots = append(bots, b)
	}

	// Inisialisasi Strategies
	strategies := strategy.NewStrategyRegistry()
	strategies.Register("noise_trader", noise.New(config.NoiseTraderConfig{
		InactiveRate:              0.0,
		MaxOrdersPerSession:       2,
		MaxLotsPerOrder:           5,
		PriceNoisePct:             0.02,
		OpeningAuctionRate:        1.0,
		ClosingAuctionRate:        1.0,
		ContinuousTickIntervalMin: 10,
		ContinuousTickIntervalMax: 30,
	}))

	strategies.Register("momentum_trader", momentum.New(config.MomentumTraderConfig{
		InactiveRate:             0.0,
		MaxOrdersPerSession:      3,
		MaxLotsPerOrder:          10,
		SpreadThresholdPct:       0.05,
		ImbalanceThreshold:       0.10,
		ReturnThreshold:          0.005,
		FairValueBrakeMultiplier: 1.5,
		OpeningAuctionRate:       1.0,
		ClosingAuctionRate:       1.0,
	}))

	strategies.Register("contrarian", contrarian.New(config.ContrarianConfig{
		InactiveRate:               0.0,
		MaxOrdersPerSession:        2,
		MaxLotsPerOrder:            8,
		DiscountThreshold:          0.10,
		PremiumThreshold:           0.10,
		ReferenceDeviationThreshold: 0.05,
		OpeningAuctionRate:         1.0,
		ClosingAuctionRate:         1.0,
	}))

	strategies.Register("event_driven", eventdriven.New(config.EventDrivenConfig{
		InactiveRate:              0.0,
		MaxOrdersPerSession:       5,
		MaxLotsPerOrder:           15,
		OpeningAuctionRate:        1.0,
		ClosingAuctionRate:        1.0,
		ContinuousTickIntervalMin: 5,
		ContinuousTickIntervalMax: 15,
	}))

	strategies.Register("market_maker", marketmaker.New(config.MarketMakerConfig{
		InactiveRate:              0.0,
		MaxOrdersPerSession:       6,
		MaxLotsPerOrder:           10,
		BaseSpreadTicks:           4,
		MaxInventoryShares:        5000,
		OpeningAuctionRate:        1.0,
		ClosingAuctionRate:        1.0,
		ContinuousTickIntervalMin: 5,
		ContinuousTickIntervalMax: 15,
	}))

	strategies.Register("value_investor", valueinvestor.New(config.ValueInvestorConfig{
		InactiveRate:              0.0,
		MaxOrdersPerSession:       1,
		MaxLotsPerOrder:           5,
		DiscountThreshold:         0.15,
		PremiumThreshold:          0.15,
		OpeningAuctionRate:        1.0,
		ClosingAuctionRate:        1.0,
		ContinuousTickIntervalMin: 5,
		ContinuousTickIntervalMax: 15,
	}))

	strategies.Register("index_tracker", indextracker.New(config.IndexTrackerConfig{
		InactiveRate:              0.0,
		MaxOrdersPerSession:       1,
		MaxLotsPerOrder:           8,
		OpeningAuctionRate:        1.0,
		ClosingAuctionRate:        1.0,
		ContinuousTickIntervalMin: 5,
		ContinuousTickIntervalMax: 15,
	}))

	strategies.Register("bandar", bandar.New(config.BandarConfig{
		InactiveRate:              0.0,
		MaxOrdersPerSession:       2,
		MaxLotsPerOrder:           50,
		FairValueBrakeMultiplier: 1.5,
		BrakeDiscount:             0.50,
		OpeningAuctionRate:        1.0,
		ClosingAuctionRate:        1.0,
		ContinuousTickIntervalMin: 5,
		ContinuousTickIntervalMax: 15,
	}))

	orderQueue := queue.NewOrderQueue(100, 30*time.Second)
	botRunner := runner.New(reg, beiClient, matsClient, orderQueue, strategies)

	// Inisialisasi Scheduler Planner
	planner := scheduler.NewPlanner(20260704, map[string]config.StrategyIntervalConfig{
		"noise_trader":    {MinSeconds: 5, MaxSeconds: 15},
		"momentum_trader": {MinSeconds: 5, MaxSeconds: 15},
		"contrarian":      {MinSeconds: 5, MaxSeconds: 15},
		"event_driven":    {MinSeconds: 5, MaxSeconds: 15},
		"market_maker":    {MinSeconds: 5, MaxSeconds: 15},
		"value_investor":  {MinSeconds: 5, MaxSeconds: 15},
		"index_tracker":   {MinSeconds: 5, MaxSeconds: 15},
		"bandar":          {MinSeconds: 5, MaxSeconds: 15},
	})

	now := time.Unix(0, 0)
	planner.Reset(bots, now)

	// Pastikan setelah beberapa detik berlalu, bot due dievaluasi
	due := planner.Due(bots, now.Add(20*time.Second))
	if len(due) == 0 {
		t.Fatalf("Expected due bots after time elapsed, got 0")
	}

	// Eksekusi concurrent batch bot runner untuk membuktikan tidak ada data race
	var wg sync.WaitGroup
	wg.Add(3)

	go func() {
		defer wg.Done()
		botRunner.RunBotDecisionsFor(ctx, "continuous", due)
	}()

	go func() {
		defer wg.Done()
		// Simulasi pembacaan signal mats concurrent
		for i := 0; i < 50; i++ {
			_ = matsState.GetLastPrice("MNDL")
			_, _ = matsState.GetBestBidAsk("MNDL")
		}
	}()

	go func() {
		defer wg.Done()
		// Simulasi pendaftaran / query bot di registry concurrent
		for i := 0; i < 50; i++ {
			_ = reg.ListBots()
		}
	}()

	wg.Wait()

	// Validasi Order Queue & Kebenaran Akuntansi (no negative balances)
	queuedCount := 0
	for {
		ctxTimeout, cancelTimeout := context.WithTimeout(ctx, 10*time.Millisecond)
		dec, err := orderQueue.Dequeue(ctxTimeout)
		cancelTimeout()
		if err != nil {
			break
		}
		queuedCount++

		// Validasi field decision wajib ada
		if dec.AccountID == "" || dec.ClientOrderID == "" || dec.Symbol != "MNDL" || dec.Quantity <= 0 || dec.Price <= 0 {
			t.Errorf("Invalid queued order decision: %+v", dec)
		}

		// Validasi balance kecukupan cash & position
		botInst, ok := reg.GetBot(dec.AccountID)
		if !ok {
			t.Fatalf("Bot not found for account %s", dec.AccountID)
		}

		availCash, _, _ := botInst.GetCash()
		pos := botInst.GetPosition("MNDL")

		if dec.Side == "buy" {
			cost := dec.Price * dec.Quantity
			if cost > availCash {
				t.Errorf("Bot %s proposed BUY cost %d exceeding available cash %d", dec.AccountID, cost, availCash)
			}
		} else if dec.Side == "sell" {
			if dec.Quantity > pos.AvailableShares {
				t.Errorf("Bot %s proposed SELL quantity %d exceeding available shares %d", dec.AccountID, dec.Quantity, pos.AvailableShares)
			}
		}
	}

	t.Logf("Simulasi selesai. Total order masuk antrean: %d", queuedCount)
}
