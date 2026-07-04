package client_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Mandala-Exchange/bot-v2/internal/admin"
	"github.com/Mandala-Exchange/bot-v2/internal/client/bei"
	"github.com/Mandala-Exchange/bot-v2/internal/client/mats"
	"github.com/Mandala-Exchange/bot-v2/internal/client/sekuritas"
	"github.com/Mandala-Exchange/bot-v2/internal/config"
	"github.com/Mandala-Exchange/bot-v2/internal/executor"
	"github.com/Mandala-Exchange/bot-v2/internal/metrics"
	"github.com/Mandala-Exchange/bot-v2/internal/queue"
	"github.com/Mandala-Exchange/bot-v2/internal/registry"
	"github.com/Mandala-Exchange/bot-v2/internal/scheduler"
	"nhooyr.io/websocket"
)

func TestBEIClient(t *testing.T) {
	// Mock BEI Server
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/bot/session-state":
			w.Write([]byte(`{"status":"continuous","segments":[]}`))
		case "/bot/daftar-saham-aktif":
			w.Write([]byte(`[{"symbol":"MNDL","board":"main","status":"listed","active_notations":[]}]`))
		case "/bot/trading-rules":
			w.Write([]byte(`[{"id":"profile-1","name":"Main Board Profile","board":"main","market_segment":"continuous","is_default":true,"metadata":{},"lot_size_rules":[],"tick_size_rules":[],"price_band_rules":[],"auto_rejection_rules":[]}]`))
		case "/bot/fee-schedule":
			w.Write([]byte(`[{"name":"default_fee","broker_buy_rate":0.0015,"broker_sell_rate":0.0025,"exchange_fee_rate":0.0004,"vat_rate":0.11}]`))
		case "/bot/ipo-lifecycle":
			w.Write([]byte(`[]`))
		case "/bot/corporate-action-minimal":
			w.Write([]byte(`[]`))
		case "/bot/news-module":
			w.Write([]byte(`[]`))
		case "/bot/fair-value-module":
			w.Write([]byte(`[{"symbol":"MNDL","fair_value":300,"confidence":"high"}]`))
		case "/bot/market-regime":
			w.Write([]byte(`{"global_regime":"neutral","sector_regimes":{},"volatility_regime":"normal"}`))
		case "/bot/liquidity-profile":
			w.Write([]byte(`[]`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer ts.Close()

	ctx := context.Background()
	bc := bei.NewClient(ts.URL, "test-token")

	// Test fast poll
	state, err := bc.PollSessionState(ctx)
	if err != nil {
		t.Fatalf("PollSessionState failed: %v", err)
	}
	if state.Status != "continuous" {
		t.Errorf("expected session status continuous, got %s", state.Status)
	}

	// Test slow poll
	err = bc.PollAllState(ctx)
	if err != nil {
		t.Fatalf("PollAllState failed: %v", err)
	}

	// Test freshness checks
	if bc.IsSessionStale() {
		t.Error("session data should not be stale immediately after fetch")
	}
	if bc.IsRulesStale() {
		t.Error("rules data should not be stale immediately after fetch")
	}
	if bc.IsFeesStale() {
		t.Error("fees data should not be stale immediately after fetch")
	}

	snap := bc.GetSnapshot()
	if len(snap.Securities) != 1 || snap.Securities[0].Symbol != "MNDL" {
		t.Errorf("expected MNDL security in snapshot, got %v", snap.Securities)
	}
}

func TestMATSWebSocketClient(t *testing.T) {
	// Mock WS Server
	wsServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "done")

		// Send session_state event
		_ = conn.Write(r.Context(), websocket.MessageText, []byte(
			`{"type":"session_state","occurred_at":"2026-07-04T00:00:00Z","payload":{"status":"continuous"}}`,
		))
		// Send last_price event
		_ = conn.Write(r.Context(), websocket.MessageText, []byte(
			`{"type":"last_price","symbol":"MNDL","occurred_at":"2026-07-04T00:00:01Z","payload":{"symbol":"MNDL","last":"318"}}`,
		))

		<-r.Context().Done()
	}))
	defer wsServer.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	wsURL := "ws" + wsServer.URL[len("http"):]
	mc := mats.NewClient(wsURL, "secret", []string{"MNDL"})

	mc.Start(ctx)

	// Wait for connection and events processing
	time.Sleep(100 * time.Millisecond)
	mc.Stop()

	state := mc.GetState()
	if state.SessionSegment != "continuous" {
		t.Errorf("expected session segment continuous, got %s", state.SessionSegment)
	}
	if state.GetLastPrice("MNDL") != "318" {
		t.Errorf("expected last price MNDL 318, got %s", state.GetLastPrice("MNDL"))
	}
}

func TestSekuritasClient(t *testing.T) {
	// Mock Sekuritas Server
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/bot/internal/provision":
			w.Write([]byte(`{"results":[{"external_bot_id":"bot1","status":"created","account_id":"acc1"}]}`))
		case "/bot/internal/tokens":
			w.Write([]byte(`{"tokens":[{"account_id":"acc1","token":"jwt_123","expires_at":"2099-01-01T00:00:00Z"}]}`))
		case "/bot/internal/portfolio-snapshot":
			w.Write([]byte(`{"as_of_sequence":100,"generated_at":"2026-07-04T00:00:00Z","accounts":[{"account_id":"acc1","cash":{"available_idr":10000000,"reserved_idr":0,"pending_idr":0},"positions":[],"open_orders":[]}]}`))
		case "/bot/orders":
			w.Write([]byte(`{"id":"ord1","client_order_id":"bot:noise:uuid:1","status":"open"}`))
		case "/bot/orders/by-client-id/bot:noise:uuid:1":
			w.Write([]byte(`{"id":"ord1","client_order_id":"bot:noise:uuid:1","status":"open"}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer ts.Close()

	ctx := context.Background()
	sc := sekuritas.NewClient(ts.URL, "secret-token")

	// 1. Provision
	provResp, err := sc.ProvisionBots(ctx, sekuritas.ProvisionBatchRequest{
		Bots: []sekuritas.ProvisionBotRequest{{ExternalBotID: "bot1", InitialCashIDR: 10000000}},
	}, "idem-provision")
	if err != nil {
		t.Fatalf("Provision failed: %v", err)
	}
	if provResp.Results[0].AccountID != "acc1" {
		t.Errorf("expected acc1 account ID, got %s", provResp.Results[0].AccountID)
	}

	// 2. Fetch Tokens
	err = sc.FetchTokens(ctx, []string{"acc1"}, "idem-tokens")
	if err != nil {
		t.Fatalf("FetchTokens failed: %v", err)
	}
	token, ok := sc.GetToken("acc1")
	if !ok || token != "jwt_123" {
		t.Errorf("failed to get valid cached token, got: %s", token)
	}

	// 3. Place Order
	ordResp, err := sc.PlaceOrder(ctx, "acc1", sekuritas.PlaceOrderRequest{
		ClientOrderID: "bot:noise:uuid:1",
		Symbol:        "MNDL",
		Side:          "buy",
		OrderType:     "limit",
		PriceIDR:      320,
		Quantity:      100,
	})
	if err != nil {
		t.Fatalf("PlaceOrder failed: %v", err)
	}
	if ordResp.ID != "ord1" {
		t.Errorf("expected ord1 order ID, got %s", ordResp.ID)
	}

	// 4. Reconcile Lookup
	recResp, err := sc.GetOrderByClientID(ctx, "acc1", "bot:noise:uuid:1")
	if err != nil {
		t.Fatalf("GetOrderByClientID failed: %v", err)
	}
	if recResp.ID != "ord1" {
		t.Errorf("expected ord1 reconciled ID, got %s", recResp.ID)
	}
}

func TestOrderQueue(t *testing.T) {
	q := queue.NewOrderQueue(2, 50*time.Millisecond)

	// Test successful enqueue
	ok1 := q.Enqueue(queue.OrderDecision{AccountID: "acc1", ClientOrderID: "1"})
	ok2 := q.Enqueue(queue.OrderDecision{AccountID: "acc2", ClientOrderID: "2"})
	if !ok1 || !ok2 {
		t.Error("expected successful enqueue for initial buffer")
	}

	// Test backpressure (queue full)
	ok3 := q.Enqueue(queue.OrderDecision{AccountID: "acc3", ClientOrderID: "3"})
	if ok3 {
		t.Error("expected backpressure to drop enqueued item when full")
	}

	// Test normal dequeue
	ctx := context.Background()
	dec1, err := q.Dequeue(ctx)
	if err != nil {
		t.Fatalf("failed dequeue: %v", err)
	}
	if dec1.ClientOrderID != "1" {
		t.Errorf("expected client_order_id 1, got %s", dec1.ClientOrderID)
	}

	// Wait for TTL expiration of decision 2
	time.Sleep(60 * time.Millisecond)

	// Dequeue should drop stale item and block or return cancelled if context cancels
	ctxTimeout, cancel := context.WithTimeout(ctx, 10*time.Millisecond)
	defer cancel()

	_, err = q.Dequeue(ctxTimeout)
	if err == nil {
		t.Error("expected timeout error due to dropping stale item")
	}
}

func TestOrderExecutorAndReconcile(t *testing.T) {
	// Mock BEI & Sekuritas Server
	reconcileHitCount := int32(0)
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/bot/session-state":
			w.Write([]byte(`{"status":"continuous"}`))
		case "/bot/trading-rules":
			w.Write([]byte(`[]`))
		case "/bot/fee-schedule":
			w.Write([]byte(`[]`))
		case "/bot/internal/tokens":
			w.Write([]byte(`{"tokens":[{"account_id":"acc1","token":"jwt_123","expires_at":"2099-01-01T00:00:00Z"}]}`))
		case "/bot/orders":
			// Simulating timeout/network failure (ErrOrderSubmitUnknown)
			w.WriteHeader(http.StatusGatewayTimeout)
		case "/bot/orders/by-client-id/bot:noise:uuid:reconcile":
			atomic.AddInt32(&reconcileHitCount, 1)
			w.Write([]byte(`{"id":"ord_reconciled","client_order_id":"bot:noise:uuid:reconcile","status":"open"}`))
		default:
			fmt.Println("MOCK SERVER 404 PATH:", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer ts.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	bc := bei.NewClient(ts.URL, "secret")
	sc := sekuritas.NewClient(ts.URL, "secret")
	reg := registry.NewRegistry()

	// Provision local bot instance with token
	reg.Register("bot1", "acc1", "noise_trader")
	sc.FetchTokens(ctx, []string{"acc1"}, "idem-token")

	// Trigger initial BEI rules & fees poll
	_, _ = bc.PollSessionState(ctx)
	_ = bc.PollAllState(ctx)

	ordQueue := queue.NewOrderQueue(10, 1*time.Second)
	exec := executor.NewExecutor(bc, sc, reg, ordQueue, 60, metrics.NewManager(), config.StrategyConfig{})
	exec.Start(ctx)

	// Inject order decision that will fail and trigger reconcile
	ordQueue.Enqueue(queue.OrderDecision{
		AccountID:     "acc1",
		ClientOrderID: "bot:noise:uuid:reconcile",
		Symbol:        "MNDL",
		Side:          "buy",
		OrderType:     "limit",
		Price:         320,
		Quantity:      100,
	})

	// Wait for executor to dequeue, fail, and run reconcile lookup loop
	time.Sleep(1200 * time.Millisecond)

	count := atomic.LoadInt32(&reconcileHitCount)
	if count == 0 {
		t.Error("expected executor to perform immediate reconcile lookup on Sekuritas endpoint")
	}

	bot, _ := reg.GetBot("acc1")
	if bot.OpenOrderIDs["bot:noise:uuid:reconcile"] != "ord_reconciled" {
		t.Errorf("expected reconciled order ID, got %s", bot.OpenOrderIDs["bot:noise:uuid:reconcile"])
	}
}

func TestAdminServer(t *testing.T) {
	_, cancel := context.WithCancel(context.Background())
	defer cancel()

	bc := bei.NewClient("http://localhost:9999", "secret")
	sc := sekuritas.NewClient("http://localhost:9999", "secret")
	reg := registry.NewRegistry()
	ordQueue := queue.NewOrderQueue(10, 1*time.Second)
	exec := executor.NewExecutor(bc, sc, reg, ordQueue, 60, metrics.NewManager(), config.StrategyConfig{})

	server := admin.NewServer(4200, bc, sc, exec, cancel, metrics.NewManager())
	httpServer := httptest.NewServer(server.Handler())
	defer httpServer.Close()

	// Test GET /health
	resp, err := http.Get(httpServer.URL + "/health")
	if err != nil {
		t.Fatalf("health check endpoint failed: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected 200 health status, got %d", resp.StatusCode)
	}

	// Test GET /metrics
	respMetrics, err := http.Get(httpServer.URL + "/metrics")
	if err != nil {
		t.Fatalf("metrics endpoint failed: %v", err)
	}
	defer respMetrics.Body.Close()
	if respMetrics.StatusCode != http.StatusOK {
		t.Errorf("expected 200 metrics status, got %d", respMetrics.StatusCode)
	}
	var metricsSnap metrics.Snapshot
	if err := json.NewDecoder(respMetrics.Body).Decode(&metricsSnap); err != nil {
		t.Fatalf("failed to decode metrics response: %v", err)
	}

	// Test POST /admin/pause
	respPause, err := http.Post(httpServer.URL+"/admin/pause", "application/json", nil)
	if err != nil {
		t.Fatalf("pause endpoint failed: %v", err)
	}
	defer respPause.Body.Close()
	if !exec.IsPaused() {
		t.Error("expected executor to be paused")
	}

	// Test POST /admin/resume
	respResume, err := http.Post(httpServer.URL+"/admin/resume", "application/json", nil)
	if err != nil {
		t.Fatalf("resume endpoint failed: %v", err)
	}
	defer respResume.Body.Close()
	if exec.IsPaused() {
		t.Error("expected executor to be running after resume")
	}
}

func TestSchedulerTransition(t *testing.T) {
	status := "pre_open"
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/bot/session-state":
			w.Write([]byte(fmt.Sprintf(`{"status":"%s"}`, status)))
		case "/bot/daftar-saham-aktif":
			w.Write([]byte(`[]`))
		case "/bot/trading-rules":
			w.Write([]byte(`[]`))
		case "/bot/fee-schedule":
			w.Write([]byte(`[]`))
		case "/bot/ipo-lifecycle":
			w.Write([]byte(`[]`))
		case "/bot/corporate-action-minimal":
			w.Write([]byte(`[]`))
		case "/bot/news-module":
			w.Write([]byte(`[]`))
		case "/bot/fair-value-module":
			w.Write([]byte(`[]`))
		case "/bot/market-regime":
			w.Write([]byte(`{}`))
		case "/bot/liquidity-profile":
			w.Write([]byte(`[]`))
		case "/bot/internal/portfolio-snapshot":
			w.Write([]byte(`{"accounts":[]}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer ts.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	bc := bei.NewClient(ts.URL, "secret")
	sc := sekuritas.NewClient(ts.URL, "secret")
	reg := registry.NewRegistry()

	sched := scheduler.NewScheduler(bc, sc, reg, nil, config.SchedulerConfig{}, 10*time.Millisecond)
	sched.Start(ctx)

	// Wait for a few ticks in pre_open
	time.Sleep(50 * time.Millisecond)

	// Change status to continuous
	status = "continuous"
	time.Sleep(50 * time.Millisecond)
}
