package client_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/Mandala-Exchange/BOT/internal/client/bei"
	"github.com/Mandala-Exchange/BOT/internal/client/mats"
	"github.com/Mandala-Exchange/BOT/internal/client/sekuritas"
	"github.com/Mandala-Exchange/BOT/internal/portfolio"
	"github.com/Mandala-Exchange/BOT/internal/reconciliation"
	"github.com/Mandala-Exchange/BOT/internal/session"
	"nhooyr.io/websocket"
)

// mockBEISecurities returns a JSON array of securities as expected by bei.ListedSymbols().
// Format per BOT_API_CONTRACTS.md §11: array of {symbol, status}.
const mockBEISecurities = `[{"symbol":"BBCA","status":"listed"},{"symbol":"TLKM","status":"listed"}]`

// mockBEISession returns a valid session instance JSON for BEI /sessions/active.
const mockBEISession = `{
	"session_instance_id":"00000000-0000-0000-0000-000000000001",
	"virtual_day_index":1,
	"virtual_duration_seconds":21600,
	"real_duration_seconds":1800,
	"real_time_remaining_seconds":900,
	"status":"continuous",
	"started_at":"2026-06-29T00:00:00Z",
	"expected_end_at":"2026-06-29T00:30:00Z",
	"version":1
}`

func TestPhase2IntegrationMock(t *testing.T) {
	// Mock Server for BEI, Sekuritas (combined for this test)
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/internal/bots/provision":
			json.NewEncoder(w).Encode(sekuritas.ProvisionBatchResponse{
				Results: []sekuritas.ProvisionResult{
					{ExternalBotID: "bot1", Status: "created", AccountID: "acc1"},
				},
			})
		case "/internal/bots/tokens":
			json.NewEncoder(w).Encode(sekuritas.TokenBatchResponse{
				Tokens: []sekuritas.TokenResult{
					{AccountID: "acc1", Token: "jwt_token_123", ExpiresAt: time.Now().Add(1 * time.Hour)},
				},
			})
		case "/internal/bots/portfolio-snapshot":
			w.Write([]byte(`{"as_of_sequence":1,"generated_at":"2026-06-29T00:00:00Z","accounts":[]}`))
		case "/public/securities":
			// NOTE: must return array (not wrapped in {"data":[]}) per bei.ListedSymbols() contract.
			w.Write([]byte(mockBEISecurities))
		case "/integration/mats/rules":
			w.Write([]byte(`{"rules": true}`))
		case "/public/fee-schedule":
			w.Write([]byte(`{"fees": true}`))
		case "/integration/mats/sessions/active":
			w.Write([]byte(mockBEISession))
		case "/indices/MDX/composition":
			w.Write([]byte(`{"composition": true}`))
		case "/announcements":
			w.Write([]byte(`[{"id":"00000000-0000-0000-0000-000000000010","issuer_id":"00000000-0000-0000-0000-000000000011","security_id":null,"symbol":"BBCA","type":"news","title":"Public","published_at":"2026-06-29T00:00:00Z","metadata":{}}]`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer ts.Close()

	ctx := context.Background()

	// 1. Provisioning & Token Client
	sc := sekuritas.NewClient(ts.URL, "secret")
	provResp, err := sc.ProvisionBots(ctx, sekuritas.ProvisionBatchRequest{
		Bots: []sekuritas.ProvisionBotRequest{{ExternalBotID: "bot1"}},
	}, "idem-1")
	if err != nil {
		t.Fatalf("Provision error: %v", err)
	}
	if len(provResp.Results) != 1 || provResp.Results[0].AccountID != "acc1" {
		t.Fatalf("Unexpected provision result")
	}

	err = sc.FetchTokens(ctx, []string{"acc1"}, "idem-2")
	if err != nil {
		t.Fatalf("FetchTokens error: %v", err)
	}
	tok, ok := sc.GetToken("acc1")
	if !ok || tok != "jwt_token_123" {
		t.Fatalf("Failed to retrieve token from cache")
	}

	// Verify token expiry is cached
	exp, hasExp := sc.TokenExpiresAt("acc1")
	if !hasExp || exp.IsZero() {
		t.Fatal("TokenExpiresAt should return a non-zero expiry")
	}
	if time.Until(exp) < 55*time.Minute {
		t.Fatal("Token expiry should be ~1 hour from now")
	}

	// 2. BulkSnapshot (uses nil account list = returns empty accounts)
	_, err = sc.BulkSnapshot(ctx, nil)
	if err != nil {
		t.Fatalf("BulkSnapshot error: %v", err)
	}

	// 3. MATS WS Client (Mocked connect)
	wsServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "done")
		_ = conn.Write(r.Context(), websocket.MessageText, []byte(
			`{"type":"depth_snapshot","sequence":1,"symbol":"BBCA","occurred_at":"2026-06-29T00:00:00Z","payload":{}}`,
		))
		<-r.Context().Done()
	}))
	defer wsServer.Close()
	wsURL := "ws" + wsServer.URL[len("http"):]
	mc := mats.NewClient(wsURL, "secret")
	mc.Configure([]string{"BBCA"}, nil)
	wsCtx, wsCancel := context.WithCancel(ctx)
	defer wsCancel()
	go func() { _ = mc.Connect(wsCtx) }()
	deadline := time.Now().Add(time.Second)
	for !mc.IsReady() && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if !mc.IsReady() {
		t.Fatalf("MATS should be ready after initial depth snapshot")
	}

	// 4. BEI Discovery with per-endpoint freshness
	bc := bei.NewClient(ts.URL, "secret")
	if err := bc.FetchData(ctx); err != nil {
		t.Fatalf("BEI fetch error: %v", err)
	}
	// Per-endpoint freshness checks (Task 2.4)
	if bc.IsStale() {
		t.Fatalf("BEI critical endpoints should not be stale immediately after fetch")
	}
	if bc.IsSessionStale() {
		t.Fatalf("BEI session should not be stale immediately")
	}
	if bc.IsRulesStale() {
		t.Fatalf("BEI rules should not be stale immediately")
	}
	if bc.IsFeesStale() {
		t.Fatalf("BEI fees should not be stale immediately")
	}
	// Session instance should be parsed from BEI response
	si := bc.GetSessionInstance()
	if si == nil {
		t.Fatal("BEI session instance should be parsed from /sessions/active response")
	}
	if si.VirtualDayIndex != 1 {
		t.Fatalf("Expected virtual_day_index=1, got %d", si.VirtualDayIndex)
	}
	if si.Status != "continuous" {
		t.Fatalf("Expected status=continuous, got %s", si.Status)
	}
	snapshot, ok := bc.Snapshot()
	if !ok || len(snapshot.Announcements) == 0 || snapshot.AnnouncementsAt.IsZero() {
		t.Fatal("BEI public announcement snapshot should be cached with receipt time")
	}

	// 5. Periodic Reconciliation (Run once)
	reconciler := reconciliation.NewReconciler(sc, portfolio.NewStore(), nil, 1*time.Minute)
	// We just ensure it builds and could run, actual Run blocks.
	_ = reconciler

	// 6. Session Monitor wired from BEI (Task 2.8)
	sm := session.NewMonitor()
	if sm.GetInstance() != nil {
		t.Fatalf("Expected nil instance initially")
	}
	// Convert BEI session instance to session monitor type (same as main.go convertBEISession)
	sm.UpdateInstance(&session.SessionInstance{
		InstanceID:          si.InstanceID,
		VirtualDayIndex:     si.VirtualDayIndex,
		VirtualDurationSecs: si.VirtualDurationSecs,
		RealDurationSecs:    si.RealDurationSecs,
		Status:              session.SessionState(si.Status),
	})
	inst := sm.GetInstance()
	if inst == nil {
		t.Fatal("Session monitor should have an instance after UpdateInstance")
	}
	if inst.VirtualDayIndex != 1 {
		t.Fatalf("Expected virtual_day_index=1 in session monitor, got %d", inst.VirtualDayIndex)
	}
}
