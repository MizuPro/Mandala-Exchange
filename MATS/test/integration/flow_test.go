package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/coder/websocket"

	"mandala-exchange/mats/internal/api"
	"mandala-exchange/mats/internal/auth"
	"mandala-exchange/mats/internal/bei"
	"mandala-exchange/mats/internal/config"
	"mandala-exchange/mats/internal/events"
	"mandala-exchange/mats/internal/httpserver"
	"mandala-exchange/mats/internal/marketdata"
	"mandala-exchange/mats/internal/matching"
	"mandala-exchange/mats/internal/orders"
	"mandala-exchange/mats/internal/persistence"
	"mandala-exchange/mats/internal/rules"
	"mandala-exchange/mats/internal/sequence"
	"mandala-exchange/mats/internal/session"
)

func TestHTTPFlowSekuritasToMATSToBEI(t *testing.T) {
	var capturedTrades atomic.Int64
	fakeBEI := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/integration/mats/securities":
			_, _ = w.Write([]byte(`[{"symbol":"MNDL","board":"main","status":"listed","market_mechanism":"regular","reference_price":"100","previous_close":"100","shares_outstanding":"1000000","active_notations":[]}]`))
		case r.Method == http.MethodGet && r.URL.Path == "/v1/integration/mats/rules":
			_, _ = w.Write([]byte(`[{"id":"rule-main","name":"Main","board":"main","market_segment":"regular","is_default":true,"lot_size_rules":[{"lot_size":100}],"tick_size_rules":[{"min_price":"1","tick_size":"1"}],"price_band_rules":[{"min_reference_price":"1","ara_percent":"10","arb_percent":"10","min_price":"1"}],"auto_rejection_rules":[{"max_lots_per_order":1000}]}]`))
		case r.Method == http.MethodGet && r.URL.Path == "/v1/integration/mats/sessions/active":
			_, _ = w.Write([]byte(`{"id":"SESSION-1","name":"Regular","status":"continuous","settlement_mode":"end_of_session","settlement_delay_sessions":0,"post_closing_enabled":true,"is_active":true,"segments":[]}`))
		case r.Method == http.MethodGet && r.URL.Path == "/v1/brokers/MDLA/validate":
			_, _ = w.Write([]byte(`{"valid":true}`))
		case r.Method == http.MethodPost && r.URL.Path == "/v1/trades/capture":
			capturedTrades.Add(1)
			_, _ = w.Write([]byte(`{"idempotent":false,"trade":{"id":"official"}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer fakeBEI.Close()

	var statusEvents atomic.Int64
	fakeSekuritas := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == "/events" {
			statusEvents.Add(1)
			w.WriteHeader(http.StatusAccepted)
			return
		}
		http.NotFound(w, r)
	}))
	defer fakeSekuritas.Close()

	router := newTestRouter(t, fakeBEI.URL+"/v1", fakeSekuritas.URL+"/events")

	buy := doJSON(t, router, http.MethodPost, "/v1/orders", map[string]any{
		"client_order_id": "BUY-1",
		"broker_code":     "MDLA",
		"account_id":      "BUYER",
		"symbol":          "MNDL",
		"side":            "buy",
		"order_type":      "limit",
		"price":           100,
		"quantity":        100,
		"idempotency_key": "buy-1",
	})
	if buy.Code != http.StatusOK {
		t.Fatalf("buy status = %d body=%s", buy.Code, buy.Body.String())
	}

	sell := doJSON(t, router, http.MethodPost, "/v1/orders", map[string]any{
		"client_order_id": "SELL-1",
		"broker_code":     "MDLA",
		"account_id":      "SELLER",
		"symbol":          "MNDL",
		"side":            "sell",
		"order_type":      "limit",
		"price":           100,
		"quantity":        100,
		"idempotency_key": "sell-1",
	})
	if sell.Code != http.StatusOK {
		t.Fatalf("sell status = %d body=%s", sell.Code, sell.Body.String())
	}
	if capturedTrades.Load() != 1 {
		t.Fatalf("expected BEI capture once, got %d", capturedTrades.Load())
	}
	if statusEvents.Load() == 0 {
		t.Fatalf("expected at least one Sekuritas order status event")
	}
}

func TestHTTPRejectsInvalidTickAndSymbolSuspend(t *testing.T) {
	router := newTestRouter(t, fakeBEIURL(t, true), "")

	badTick := doJSON(t, router, http.MethodPost, "/v1/orders", map[string]any{
		"client_order_id": "BAD-TICK",
		"broker_code":     "MDLA",
		"account_id":      "BUYER",
		"symbol":          "MNDL",
		"side":            "buy",
		"order_type":      "limit",
		"price":           103,
		"quantity":        100,
		"idempotency_key": "bad-tick",
	})
	if badTick.Code != http.StatusOK || !strings.Contains(badTick.Body.String(), "price_not_valid_tick") {
		t.Fatalf("expected invalid tick reject, status=%d body=%s", badTick.Code, badTick.Body.String())
	}

	suspend := doJSON(t, router, http.MethodPost, "/v1/admin/symbols/MNDL/suspend", map[string]any{"reason": "test_suspend"})
	if suspend.Code != http.StatusOK {
		t.Fatalf("suspend status = %d body=%s", suspend.Code, suspend.Body.String())
	}

	rejected := doJSON(t, router, http.MethodPost, "/v1/orders", map[string]any{
		"client_order_id": "SUSPENDED",
		"broker_code":     "MDLA",
		"account_id":      "BUYER",
		"symbol":          "MNDL",
		"side":            "buy",
		"order_type":      "limit",
		"price":           100,
		"quantity":        100,
		"idempotency_key": "suspended-order",
	})
	if rejected.Code != http.StatusOK || !strings.Contains(rejected.Body.String(), "test_suspend") {
		t.Fatalf("expected suspend reject, status=%d body=%s", rejected.Code, rejected.Body.String())
	}
}

func TestWebSocketSnapshotAndMarketSummary(t *testing.T) {
	router := newTestRouter(t, fakeBEIURL(t, false), "")
	server := httptest.NewServer(router)
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/v1/market-data/ws?symbols=MNDL"
	header := http.Header{"x-service-token": []string{"test-token"}}
	conn, _, err := websocket.Dial(context.Background(), wsURL, &websocket.DialOptions{HTTPHeader: header})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "done")

	_, payload, err := conn.Read(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(payload, []byte("session_state")) {
		t.Fatalf("expected session state snapshot, got %s", string(payload))
	}
}

func newTestRouter(t *testing.T, beiBaseURL string, sekuritasEventsURL string) http.Handler {
	t.Helper()
	ctx := context.Background()
	store := persistence.NewMemoryStore()
	seq := sequence.NewAtomic(0)
	beiClient := bei.NewClient(beiBaseURL, "test-bei-token")
	rulesCache := rules.NewCache(beiClient)
	if err := rulesCache.Refresh(ctx); err != nil {
		t.Fatalf("rules refresh: %v", err)
	}
	hub := marketdata.NewHub()
	engine := matching.NewEngine(seq, "SESSION-1", marketdata.NewSummaryStore())
	hub.SetProviders(engine, rulesCache)
	dispatcher := events.NewDispatcher(store, seq, beiClient, hub, events.Config{
		SekuritasEventsURL:    sekuritasEventsURL,
		SekuritasServiceToken: "test-sekuritas-token",
		MaxAttempts:           1,
	}, nil)
	orderService := orders.NewService(engine, store, seq, rulesCache, orders.NewBEIBrokerValidator(beiClient))
	orderService.SetDispatcher(dispatcher)
	sessionController := session.NewController(rulesCache, orderService, dispatcher)
	handler := api.NewHandler(orderService, engine, rulesCache, store, sessionController, dispatcher)
	return httpserver.NewRouter(handler, auth.New([]config.ServiceToken{{
		Name:   "test",
		Token:  "test-token",
		Scopes: []string{"admin:*", "order:write", "order:read", "market:read", "sync:write"},
	}}), hub)
}

func fakeBEIURL(t *testing.T, tickSizeFive bool) string {
	t.Helper()
	tickSize := "1"
	if tickSizeFive {
		tickSize = "5"
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/integration/mats/securities":
			_, _ = w.Write([]byte(`[{"symbol":"MNDL","board":"main","status":"listed","market_mechanism":"regular","reference_price":"100","previous_close":"100","shares_outstanding":"1000000","active_notations":[]}]`))
		case r.Method == http.MethodGet && r.URL.Path == "/v1/integration/mats/rules":
			_, _ = w.Write([]byte(`[{"id":"rule-main","name":"Main","board":"main","market_segment":"regular","is_default":true,"lot_size_rules":[{"lot_size":100}],"tick_size_rules":[{"min_price":"1","tick_size":"` + tickSize + `"}],"price_band_rules":[{"min_reference_price":"1","ara_percent":"10","arb_percent":"10","min_price":"1"}],"auto_rejection_rules":[{"max_lots_per_order":1000}]}]`))
		case r.Method == http.MethodGet && r.URL.Path == "/v1/integration/mats/sessions/active":
			_, _ = w.Write([]byte(`{"id":"SESSION-1","name":"Regular","status":"continuous","settlement_mode":"end_of_session","settlement_delay_sessions":0,"post_closing_enabled":true,"is_active":true,"segments":[]}`))
		case r.Method == http.MethodGet && r.URL.Path == "/v1/brokers/MDLA/validate":
			_, _ = w.Write([]byte(`{"valid":true}`))
		case r.Method == http.MethodPost && r.URL.Path == "/v1/trades/capture":
			_, _ = w.Write([]byte(`{"idempotent":false}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	return server.URL + "/v1"
}

func doJSON(t *testing.T, router http.Handler, method, path string, payload any) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(method, path, bytes.NewReader(body))
	request.Header.Set("content-type", "application/json")
	request.Header.Set("x-service-token", "test-token")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	return response
}
