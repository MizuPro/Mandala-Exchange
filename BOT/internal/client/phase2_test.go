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

func TestPhase2IntegrationMock(t *testing.T) {
	// Mock Server for BEI, MATS HTTP, Sekuritas
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
			w.Write([]byte(`{"data": []}`))
		case "/integration/mats/rules":
			w.Write([]byte(`{"rules": true}`))
		case "/public/fee-schedule":
			w.Write([]byte(`{"fees": true}`))
		case "/integration/mats/sessions/active":
			w.Write([]byte(`{"session_instance_id":"00000000-0000-0000-0000-000000000001"}`))
		case "/indices/MDX/composition":
			w.Write([]byte(`{"composition": true}`))
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

	// 2. Genesis & Snapshot
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
		_ = conn.Write(r.Context(), websocket.MessageText, []byte(`{"type":"depth_snapshot","sequence":1,"symbol":"BBCA","occurred_at":"2026-06-29T00:00:00Z","payload":{}}`))
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

	// 4. BEI Discovery
	bc := bei.NewClient(ts.URL, "secret")
	if err := bc.FetchData(ctx); err != nil {
		t.Fatalf("BEI fetch error: %v", err)
	}
	if bc.IsStale() {
		t.Fatalf("BEI should not be stale immediately")
	}

	// 5. Periodic Reconciliation (Run once)
	reconciler := reconciliation.NewReconciler(sc, portfolio.NewStore(), nil, 1*time.Minute)
	// We just ensure it builds and could run, actual Run blocks.
	_ = reconciler

	// 6. Session Monitor
	sm := session.NewMonitor()
	if sm.GetInstance() != nil {
		t.Fatalf("Expected nil instance initially")
	}
}
