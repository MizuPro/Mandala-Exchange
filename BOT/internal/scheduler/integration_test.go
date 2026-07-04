package scheduler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"strings"
	"sync/atomic"

	"nhooyr.io/websocket"

	"github.com/Mandala-Exchange/bot-v2/internal/client/bei"
	"github.com/Mandala-Exchange/bot-v2/internal/client/mats"
	"github.com/Mandala-Exchange/bot-v2/internal/client/sekuritas"
	"github.com/Mandala-Exchange/bot-v2/internal/config"
	"github.com/Mandala-Exchange/bot-v2/internal/ipo"
	"github.com/Mandala-Exchange/bot-v2/internal/metrics"
	"github.com/Mandala-Exchange/bot-v2/internal/queue"
	"github.com/Mandala-Exchange/bot-v2/internal/registry"
	"github.com/Mandala-Exchange/bot-v2/internal/runner"
	"github.com/Mandala-Exchange/bot-v2/internal/strategy"
)

type deterministicStrategy struct{}

func (deterministicStrategy) Decide(
	_ context.Context,
	bot *registry.BotInstance,
	_ bei.Snapshot,
	_ *mats.MarketState,
	_ string,
) []queue.OrderDecision {
	return []queue.OrderDecision{{
		AccountID:     bot.AccountID,
		ClientOrderID: "bot:" + bot.ExternalBotID + ":test:1",
		Symbol:        "MNDL",
		Side:          "buy",
		OrderType:     "limit",
		Price:         320,
		Quantity:      100,
	}}
}

type warmingUpDeterministicStrategy struct{}

func (warmingUpDeterministicStrategy) Decide(
	_ context.Context,
	bot *registry.BotInstance,
	_ bei.Snapshot,
	matsState *mats.MarketState,
	segment string,
) []queue.OrderDecision {
	if matsState != nil && matsState.IsWarmingUp("BARA") && segment != "opening_auction" {
		return nil
	}
	return []queue.OrderDecision{{
		AccountID:     bot.AccountID,
		ClientOrderID: "bot:" + bot.ExternalBotID + ":test:1",
		Symbol:        "BARA",
		Side:          "buy",
		OrderType:     "limit",
		Price:         150,
		Quantity:      100,
	}}
}

func TestTwentyBotsFlowFromPlannerToRunnerQueue(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/bot/session-state" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"session-4a","status":"continuous"}`))
	}))
	defer server.Close()

	ctx := context.Background()
	beiClient := bei.NewClient(server.URL, "test")
	if _, err := beiClient.PollSessionState(ctx); err != nil {
		t.Fatal(err)
	}
	matsClient := mats.NewClient("ws://example.invalid", "", []string{"MNDL"})
	reg := registry.NewRegistry()
	bots := make([]*registry.BotInstance, 0, 20)
	for index := 0; index < 20; index++ {
		accountID := "account-" + time.Unix(int64(index), 0).Format("150405")
		bots = append(bots, reg.Register("noise-test", accountID, "noise_trader"))
	}

	orderQueue := queue.NewOrderQueue(25, time.Minute)
	strategies := strategy.NewStrategyRegistry()
	strategies.Register("noise_trader", deterministicStrategy{})
	botRunner := runner.New(reg, beiClient, matsClient, orderQueue, strategies)
	planner := NewPlanner(42, map[string]config.StrategyIntervalConfig{
		"noise_trader": {MinSeconds: 1, MaxSeconds: 20},
	})
	now := time.Unix(0, 0)
	planner.Reset(bots, now)
	due := planner.Due(bots, now.Add(21*time.Second))
	if len(due) != 20 {
		t.Fatalf("expected 20 due bots, got %d", len(due))
	}

	botRunner.RunBotDecisionsFor(ctx, "continuous", due)
	for index := 0; index < 20; index++ {
		if _, err := orderQueue.Dequeue(ctx); err != nil {
			t.Fatalf("order %d was not queued: %v", index, err)
		}
	}
}

func TestDynamicListedUniverseAndMatsResubscription(t *testing.T) {
	var ipoStatus atomic.Value
	ipoStatus.Store("subscription")

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/bot/ipo-lifecycle":
			status := ipoStatus.Load().(string)
			_, _ = w.Write([]byte(`{
				"items": [
					{
						"ipo_event_id": "ipo-event-xyz",
						"symbol": "BARA",
						"status": "` + status + `",
						"offering_price_idr": 150,
						"subscription_lot_size": 100,
						"version": 2
					}
				],
				"as_of": "2026-07-04T00:00:00Z"
			}`))
		case "/bot/daftar-saham-aktif":
			status := ipoStatus.Load().(string)
			if status == "listed" {
				_, _ = w.Write([]byte(`[
					{"symbol":"MNDL","board":"main","status":"listed","reference_price":320},
					{"symbol":"BARA","board":"development","status":"listed","reference_price":150}
				]`))
			} else {
				_, _ = w.Write([]byte(`[
					{"symbol":"MNDL","board":"main","status":"listed","reference_price":320}
				]`))
			}
		case "/bot/session-state":
			_, _ = w.Write([]byte(`{"id":"session-4a","status":"continuous"}`))
		case "/bot/trading-rules":
			_, _ = w.Write([]byte(`[]`))
		case "/bot/fee-schedule":
			_, _ = w.Write([]byte(`[]`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	beiClient := bei.NewClient(server.URL, "test")
	sekClient := sekuritas.NewClient(server.URL, "test")
	
	activeConns := make(chan *websocket.Conn, 10)
	wsServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err == nil {
			activeConns <- conn
			defer conn.Close(websocket.StatusNormalClosure, "")
			for {
				_, _, err2 := conn.Read(r.Context())
				if err2 != nil {
					break
				}
			}
		}
	}))
	defer wsServer.Close()

	wsURL := "ws" + strings.TrimPrefix(wsServer.URL, "http")
	matsClient := mats.NewClient(wsURL, "test", []string{"MNDL"})
	
	matsClient.Start(ctx)

	// Dapatkan koneksi pertama
	var conn1 *websocket.Conn
	select {
	case conn1 = <-activeConns:
	case <-time.After(time.Second):
		t.Fatal("initial WS connection timeout")
	}
	_ = conn1

	reg := registry.NewRegistry()
	ipoReg := ipo.NewIPORegistry()
	met := metrics.NewManager()
	
	ipoCfg := config.IPOConfig{
		EnableIPOSubscription: true,
		DeterministicSeed:      42,
		MaxCashExposurePct:     map[string]float64{"moderate": 0.1},
	}
	ipoManager := ipo.NewManager(ipoReg, sekClient, reg, ipoCfg, met)

	sched := NewScheduler(
		beiClient,
		sekClient,
		reg,
		nil,
		config.SchedulerConfig{},
		50*time.Millisecond,
		ipoManager,
		matsClient,
	)

	if err := beiClient.PollAllState(ctx); err != nil {
		t.Fatal(err)
	}

	matsClient.UpdateSymbols([]string{"MNDL"})

	// Lakukan poll pertama (simulasi status IPO masih "subscription")
	sched.tickIPO(ctx)

	// BARA belum listed
	if matsClient.GetState().IsWarmingUp("BARA") {
		t.Error("BARA should not be warming up yet")
	}

	// Change status to listed
	ipoStatus.Store("listed")

	// Lakukan poll kedua (simulasi status IPO berubah menjadi "listed")
	sched.tickIPO(ctx)

	// BARA harus warming up setelah tickIPO memproses listing
	if !matsClient.GetState().IsWarmingUp("BARA") {
		t.Error("expected BARA to be warming up after dynamic resubscription trigger")
	}

	// Mats client akan memicu reconnect, koneksi baru harus masuk ke channel activeConns
	var conn2 *websocket.Conn
	select {
	case conn2 = <-activeConns:
	case <-time.After(time.Second):
		t.Fatal("reconnected WS connection timeout")
	}

	// Persiapkan bot dengan warmingUpDeterministicStrategy
	bot := reg.Register("test-bot", "acc-test", "warming_up_strategy")
	strat := warmingUpDeterministicStrategy{}

	// Ketika BARA masih warming up, keputusan order harus ditolak (nil)
	decisionsWarming := strat.Decide(ctx, bot, bei.Snapshot{}, matsClient.GetState(), "continuous")
	if len(decisionsWarming) != 0 {
		t.Errorf("expected 0 decisions when BARA is warming up, got %d", len(decisionsWarming))
	}

	// Kirim event last_price untuk BARA ke conn2 (menyelesaikan warming up)
	payloadMsg := []byte(`{"type":"last_price","symbol":"BARA","payload":{"symbol":"BARA","last":150}}`)
	if err := conn2.Write(ctx, websocket.MessageText, payloadMsg); err != nil {
		t.Fatalf("failed to write last_price event: %v", err)
	}

	// Beri waktu 100ms agar readLoop memproses event last_price
	time.Sleep(100 * time.Millisecond)

	// BARA warming_up harus sudah false sekarang
	if matsClient.GetState().IsWarmingUp("BARA") {
		t.Error("expected BARA to finish warming up after receiving last_price event")
	}

	// Ketika BARA sudah ready (warming up = false), keputusan order harus diperbolehkan
	decisionsReady := strat.Decide(ctx, bot, bei.Snapshot{}, matsClient.GetState(), "continuous")
	if len(decisionsReady) != 1 {
		t.Errorf("expected 1 decision when BARA is ready, got %d", len(decisionsReady))
	}
	if decisionsReady[0].Symbol != "BARA" {
		t.Errorf("expected BARA order, got %s", decisionsReady[0].Symbol)
	}
}
