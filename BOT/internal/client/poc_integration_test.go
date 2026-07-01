package client_test

// poc_integration_test.go
//
// Exit criteria PoC untuk Fase 2: Konektivitas, Identity, Market State, dan Recovery.
//
// Skenario yang diuji per BOT_MAIN_PLAN.md Fase 2 exit criteria:
//  1. Provision 10 bot → terima account_id untuk masing-masing
//  2. Fetch token batch → semua 10 token tersimpan di cache dengan expiry
//  3. Token expiry defense: GetToken mengembalikan false untuk token yang sudah expired
//  4. Bulk snapshot (10 akun, 1 batch) → portfolio store ter-update dengan as_of_sequence
//  5. Account event stream: terima 5 event berurutan → store apply semua, lastSequence = 5
//  6. Sequence gap detection: event sequence 7 (loncat dari 5) → ErrSequenceGap
//  7. Snapshot-and-replay setelah gap: store replace → lastSequence di-reset ke snapshot
//  8. MATS WebSocket: depth_snapshot untuk semua simbol → IsReady() = true
//  9. Session rollover: dua session instance berbeda → OnRollover callback dipanggil tepat 1x
// 10. Restart dengan open order: snapshot berisi open order, event tidak create duplikat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Mandala-Exchange/BOT/internal/client/bei"
	"github.com/Mandala-Exchange/BOT/internal/client/mats"
	"github.com/Mandala-Exchange/BOT/internal/client/sekuritas"
	"github.com/Mandala-Exchange/BOT/internal/portfolio"
	"github.com/Mandala-Exchange/BOT/internal/session"
	"github.com/google/uuid"
	"nhooyr.io/websocket"
)

// ── Test Helpers ─────────────────────────────────────────────────────────────

// build10BotIDs returns 10 deterministic account IDs for the PoC.
func build10BotIDs() (extIDs []string, accIDs []string) {
	for i := 1; i <= 10; i++ {
		extIDs = append(extIDs, fmt.Sprintf("poc-bot-%02d", i))
		accIDs = append(accIDs, fmt.Sprintf("poc-acc-%02d", i))
	}
	return
}

// buildProvisionResponse creates a mock provision batch response for 10 bots.
func buildProvisionResponse(extIDs, accIDs []string) sekuritas.ProvisionBatchResponse {
	results := make([]sekuritas.ProvisionResult, len(extIDs))
	for i := range extIDs {
		results[i] = sekuritas.ProvisionResult{
			ExternalBotID: extIDs[i],
			Status:        "created",
			AccountID:     accIDs[i],
		}
	}
	return sekuritas.ProvisionBatchResponse{Results: results}
}

// buildTokenResponse creates token batch response for accIDs with given expiry.
func buildTokenResponse(accIDs []string, expiry time.Time) sekuritas.TokenBatchResponse {
	tokens := make([]sekuritas.TokenResult, len(accIDs))
	for i, id := range accIDs {
		tokens[i] = sekuritas.TokenResult{
			AccountID: id,
			Token:     "jwt-" + id,
			IssuedAt:  time.Now(),
			ExpiresAt: expiry,
		}
	}
	return sekuritas.TokenBatchResponse{Tokens: tokens}
}

// buildSnapshotResponse creates a snapshot with len(accIDs) accounts, each with 100 IDR cash
// and one BBCA position. Open order is included if includeOrder = true.
func buildSnapshotResponse(accIDs []string, asOfSeq int64, includeOrder bool) portfolio.Snapshot {
	accounts := make([]portfolio.Account, len(accIDs))
	for i, id := range accIDs {
		acc := portfolio.Account{
			AccountID: id,
			Cash:      portfolio.Cash{AvailableIDR: 100_000_000},
			Positions: []portfolio.Position{
				{Symbol: "BBCA", AvailableShares: 100, AveragePriceIDR: 9000},
			},
		}
		if includeOrder {
			acc.OpenOrders = []portfolio.OpenOrder{
				{OrderID: "ord-" + id, ClientOrderID: "coid-" + id, Symbol: "BBCA", Side: "buy", Status: "open", QuantityShares: 10, EntityVersion: 1},
			}
		}
		accounts[i] = acc
	}
	return portfolio.Snapshot{AsOfSequence: asOfSeq, GeneratedAt: time.Now(), Accounts: accounts}
}

// ── Main PoC Test ─────────────────────────────────────────────────────────────

func TestPhase2PoC10Bot(t *testing.T) {
	extIDs, accIDs := build10BotIDs()
	tokenExpiry := time.Now().Add(1 * time.Hour)

	// ── Mock HTTP Server (Sekuritas + BEI combined) ───────────────────────────
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/internal/bots/provision":
			json.NewEncoder(w).Encode(buildProvisionResponse(extIDs, accIDs))
		case "/internal/bots/tokens":
			json.NewEncoder(w).Encode(buildTokenResponse(accIDs, tokenExpiry))
		case "/internal/bots/portfolio-snapshot":
			snap := buildSnapshotResponse(accIDs, 10, false)
			json.NewEncoder(w).Encode(snap)
		case "/public/securities":
			w.Write([]byte(`[{"symbol":"BBCA","status":"listed"},{"symbol":"TLKM","status":"listed"},{"symbol":"ASII","status":"listed"}]`))
		case "/integration/mats/rules":
			w.Write([]byte(`{"lot_size":100,"max_order_qty":200}`))
		case "/public/fee-schedule":
			w.Write([]byte(`{"buy_fee_pct":"0.0019","sell_fee_pct":"0.0029"}`))
		case "/integration/mats/sessions/active":
			w.Write([]byte(`{
				"session_instance_id":"11111111-0000-0000-0000-000000000001",
				"virtual_day_index":1,"virtual_duration_seconds":21600,
				"real_duration_seconds":1800,"real_time_remaining_seconds":900,
				"status":"continuous","started_at":"2026-06-29T00:00:00Z",
				"expected_end_at":"2026-06-29T00:30:00Z","version":1
			}`))
		case "/indices/MDX/composition":
			w.Write([]byte(`{"symbols":["BBCA","TLKM"]}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer ts.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sc := sekuritas.NewClient(ts.URL, "test-service-token")

	// ──────────────────────────────────────────────────────────────────────────
	// EXIT CRITERIA 1: Provision 10 bot → terima 10 account_id
	// ──────────────────────────────────────────────────────────────────────────
	t.Run("provision_10_bots", func(t *testing.T) {
		bots := make([]sekuritas.ProvisionBotRequest, len(extIDs))
		for i, id := range extIDs {
			bots[i] = sekuritas.ProvisionBotRequest{ExternalBotID: id, Tier: "standard"}
		}
		resp, err := sc.ProvisionBots(ctx, sekuritas.ProvisionBatchRequest{Bots: bots}, "poc-provision-"+uuid.NewString())
		if err != nil {
			t.Fatalf("ProvisionBots failed: %v", err)
		}
		if len(resp.Results) != 10 {
			t.Fatalf("Expected 10 provision results, got %d", len(resp.Results))
		}
		for i, r := range resp.Results {
			if r.AccountID != accIDs[i] {
				t.Errorf("Bot %d: expected account_id=%s, got %s", i, accIDs[i], r.AccountID)
			}
			if r.Status != "created" {
				t.Errorf("Bot %d: expected status=created, got %s", i, r.Status)
			}
		}
	})

	// ──────────────────────────────────────────────────────────────────────────
	// EXIT CRITERIA 2: Fetch token batch → semua 10 token di cache
	// ──────────────────────────────────────────────────────────────────────────
	t.Run("fetch_tokens_10_accounts", func(t *testing.T) {
		err := sc.FetchTokens(ctx, accIDs, "poc-tokens-"+uuid.NewString())
		if err != nil {
			t.Fatalf("FetchTokens failed: %v", err)
		}
		for _, id := range accIDs {
			tok, ok := sc.GetToken(id)
			if !ok {
				t.Errorf("GetToken returned false for account %s", id)
			}
			if tok != "jwt-"+id {
				t.Errorf("Token mismatch for %s: got %q", id, tok)
			}
			exp, hasExp := sc.TokenExpiresAt(id)
			if !hasExp || exp.IsZero() {
				t.Errorf("No expiry cached for %s", id)
			}
			if time.Until(exp) < 55*time.Minute {
				t.Errorf("Token expiry too soon for %s", id)
			}
		}
	})

	// ──────────────────────────────────────────────────────────────────────────
	// EXIT CRITERIA 3: GetToken mengembalikan false untuk token expired
	// ──────────────────────────────────────────────────────────────────────────
	t.Run("expired_token_not_returned", func(t *testing.T) {
		// Buat mock server khusus yang mengembalikan token dengan expiry di masa lalu
		expiredTS := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(sekuritas.TokenBatchResponse{
				Tokens: []sekuritas.TokenResult{
					{AccountID: "expired-acc", Token: "old-jwt", ExpiresAt: time.Now().Add(-1 * time.Minute)},
				},
			})
		}))
		defer expiredTS.Close()

		expiredClient := sekuritas.NewClient(expiredTS.URL, "test")
		err := expiredClient.FetchTokens(ctx, []string{"expired-acc"}, "exp-idem")
		if err != nil {
			t.Fatalf("FetchTokens failed: %v", err)
		}
		// GetToken MUST return false for expired token (defense against stale JWT usage)
		_, ok := expiredClient.GetToken("expired-acc")
		if ok {
			t.Fatal("GetToken must return false for expired token (defense requirement)")
		}
	})

	// ──────────────────────────────────────────────────────────────────────────
	// EXIT CRITERIA 4: Bulk snapshot → portfolio store ter-update
	// ──────────────────────────────────────────────────────────────────────────
	t.Run("bulk_snapshot_10_accounts", func(t *testing.T) {
		// BulkSnapshot hanya mendukung max 100 per batch — 10 akun = 1 batch
		snap, err := sc.BulkSnapshot(ctx, accIDs)
		if err != nil {
			t.Fatalf("BulkSnapshot failed: %v", err)
		}
		if snap.AsOfSequence != 10 {
			t.Errorf("Expected as_of_sequence=10, got %d", snap.AsOfSequence)
		}
		if len(snap.Accounts) != 10 {
			t.Errorf("Expected 10 accounts, got %d", len(snap.Accounts))
		}

		store := portfolio.NewStore()
		store.Replace(snap)
		if store.LastSequence() != 10 {
			t.Errorf("Store lastSequence should be 10 after Replace, got %d", store.LastSequence())
		}
		acc, ok := store.Account(accIDs[0])
		if !ok {
			t.Fatalf("Account %s not found in store after Replace", accIDs[0])
		}
		if acc.Cash.AvailableIDR != 100_000_000 {
			t.Errorf("Expected 100_000_000 IDR, got %d", acc.Cash.AvailableIDR)
		}
	})

	// ──────────────────────────────────────────────────────────────────────────
	// EXIT CRITERIA 5–7: Account event stream via WebSocket
	// ──────────────────────────────────────────────────────────────────────────
	t.Run("account_event_stream_sequence_and_gap", func(t *testing.T) {
		store := portfolio.NewStore()
		store.Replace(portfolio.Snapshot{AsOfSequence: 10, Accounts: func() []portfolio.Account {
			accs := make([]portfolio.Account, len(accIDs))
			for i, id := range accIDs {
				accs[i] = portfolio.Account{AccountID: id, Cash: portfolio.Cash{AvailableIDR: 100_000_000}}
			}
			return accs
		}()})

		// Mock event stream WS server — sends 5 sequential events then disconnects
		var receivedEvents int64
		eventWSServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			conn, err := websocket.Accept(w, r, nil)
			if err != nil {
				return
			}
			defer conn.Close(websocket.StatusNormalClosure, "done")

			for seq := int64(11); seq <= 15; seq++ {
				event := portfolio.Event{
					EventID:   fmt.Sprintf("evt-%d", seq),
					Sequence:  seq,
					AccountID: accIDs[0],
					EventType: "cash_update",
					Payload:   json.RawMessage(fmt.Sprintf(`{"account":{"account_id":%q,"cash":{"available_idr":"%d","reserved_idr":"0","pending_idr":"0"},"positions":[],"open_orders":[]}}`, accIDs[0], seq*1000)),
				}
				b, _ := json.Marshal(event)
				if err := conn.Write(r.Context(), websocket.MessageText, b); err != nil {
					return
				}
				atomic.AddInt64(&receivedEvents, 1)
			}
			// Disconnect cleanly after 5 events
		}))
		defer eventWSServer.Close()

		wsURL := "ws" + eventWSServer.URL[len("http"):]
		eventClient := sekuritas.NewClient(wsURL, "test")

		err := eventClient.ConnectEventStream(ctx, store.LastSequence(), func(ev portfolio.Event) error {
			return store.Apply(ev)
		})
		// Expect EOF or normal closure after 5 events
		if err != nil && !isNormalClose(err) {
			t.Fatalf("Event stream unexpected error: %v", err)
		}
		if store.LastSequence() != 15 {
			t.Errorf("Expected lastSequence=15 after 5 events, got %d", store.LastSequence())
		}

		// EXIT CRITERIA 6: Gap detection — sequence 17 when last = 15 → ErrSequenceGap
		gapEvent := portfolio.Event{EventID: "gap-evt", Sequence: 17, AccountID: accIDs[0], EventType: "cash_update"}
		err = store.Apply(gapEvent)
		if !errors.Is(err, portfolio.ErrSequenceGap) {
			t.Fatalf("Expected ErrSequenceGap for sequence 17 when last=15, got: %v", err)
		}
		// LastSequence must NOT advance on gap
		if store.LastSequence() != 15 {
			t.Errorf("Gap event must not advance lastSequence; got %d", store.LastSequence())
		}

		// EXIT CRITERIA 7: Snapshot-and-replay after gap
		// Replace resets the store to the new as_of_sequence
		freshSnap := buildSnapshotResponse(accIDs, 20, false)
		store.Replace(freshSnap)
		if store.LastSequence() != 20 {
			t.Errorf("After snapshot-and-replay, expected lastSequence=20, got %d", store.LastSequence())
		}
	})

	// ──────────────────────────────────────────────────────────────────────────
	// EXIT CRITERIA 8: MATS WebSocket — depth_snapshot untuk 3 simbol → IsReady()
	// ──────────────────────────────────────────────────────────────────────────
	t.Run("mats_ws_ready_after_all_snapshots", func(t *testing.T) {
		symbols := []string{"BBCA", "TLKM", "ASII"}
		matsWS := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			conn, err := websocket.Accept(w, r, nil)
			if err != nil {
				return
			}
			defer conn.Close(websocket.StatusNormalClosure, "done")
			for _, sym := range symbols {
				msg := fmt.Sprintf(
					`{"type":"depth_snapshot","sequence":1,"symbol":%q,"occurred_at":"2026-06-29T00:00:00Z","payload":{}}`,
					sym,
				)
				if err := conn.Write(r.Context(), websocket.MessageText, []byte(msg)); err != nil {
					return
				}
			}
			// Send heartbeat
			conn.Write(r.Context(), websocket.MessageText, []byte(
				`{"type":"heartbeat","sequence":2,"symbol":"","occurred_at":"2026-06-29T00:00:01Z","payload":null}`,
			))
			<-r.Context().Done()
		}))
		defer matsWS.Close()

		wsURL := "ws" + matsWS.URL[len("http"):]
		mc := mats.NewClient(wsURL, "test")
		mc.Configure(symbols, nil)

		wsCtx, wsCancel := context.WithCancel(ctx)
		defer wsCancel()
		go func() { _ = mc.Connect(wsCtx) }()

		// Wait up to 2 seconds for MATS to become ready
		deadline := time.Now().Add(2 * time.Second)
		for !mc.IsReady() && time.Now().Before(deadline) {
			time.Sleep(2 * time.Millisecond)
		}
		if !mc.IsReady() {
			t.Fatal("MATS should be ready after receiving depth_snapshot for all symbols")
		}
		if mc.LastSequence() < 1 {
			t.Errorf("Expected lastSequence >= 1, got %d", mc.LastSequence())
		}
	})

	// ──────────────────────────────────────────────────────────────────────────
	// EXIT CRITERIA 9: Session rollover — callback dipanggil tepat 1x
	// ──────────────────────────────────────────────────────────────────────────
	t.Run("session_rollover_fires_once", func(t *testing.T) {
		sm := session.NewMonitor()
		var rollovers int32
		sm.OnRollover(func(prev, curr session.SessionInstance) {
			atomic.AddInt32(&rollovers, 1)
		})

		firstID := uuid.New()
		secondID := uuid.New()
		first := &session.SessionInstance{InstanceID: firstID, VirtualDayIndex: 1, VirtualDurationSecs: 21600, RealDurationSecs: 1800, Status: session.StateContinuous}
		second := &session.SessionInstance{InstanceID: secondID, VirtualDayIndex: 2, VirtualDurationSecs: 21600, RealDurationSecs: 1800, Status: session.StateContinuous}

		sm.UpdateInstance(first)
		if sm.GetInstance() == nil {
			t.Fatal("Instance should not be nil after first UpdateInstance")
		}
		if !sm.IsActive() {
			t.Fatal("Session should be active during continuous status")
		}

		// Same instance again — should not fire rollover
		sm.UpdateInstance(first)
		if atomic.LoadInt32(&rollovers) != 0 {
			t.Fatal("Rollover should not fire when same instance is updated again")
		}

		// Regressed VirtualDayIndex — monotonicity: should be silently dropped
		regressed := &session.SessionInstance{InstanceID: uuid.New(), VirtualDayIndex: 0, VirtualDurationSecs: 21600, RealDurationSecs: 1800}
		sm.UpdateInstance(regressed)
		if atomic.LoadInt32(&rollovers) != 0 {
			t.Fatal("Rollover should not fire for regressed VirtualDayIndex")
		}
		if sm.GetInstance().VirtualDayIndex != 1 {
			t.Fatal("Regressed instance must not replace current")
		}

		// Second instance — must fire exactly 1 rollover
		sm.UpdateInstance(second)
		if count := atomic.LoadInt32(&rollovers); count != 1 {
			t.Fatalf("Expected exactly 1 rollover, got %d", count)
		}

		// VirtualToRealDelay: virtual=12min, ratio=1800/21600=1/12 → real=1min
		realDelay := sm.VirtualToRealDelay(12 * time.Minute)
		if realDelay != time.Minute {
			t.Errorf("Expected 1 min real delay, got %s", realDelay)
		}

		// NonCancellation period check
		ncpSession := &session.SessionInstance{InstanceID: uuid.New(), VirtualDayIndex: 3, VirtualDurationSecs: 21600, RealDurationSecs: 1800, Status: session.StateNonCancellation}
		sm.UpdateInstance(ncpSession)
		if !sm.IsNonCancellation() {
			t.Fatal("IsNonCancellation() should return true during non_cancellation status")
		}
		if sm.IsActive() {
			t.Fatal("IsActive() should return false during non_cancellation status")
		}
	})

	// ──────────────────────────────────────────────────────────────────────────
	// EXIT CRITERIA 10: Restart dengan open order — snapshot berisi open order,
	// event tidak create duplikat reservation
	// ──────────────────────────────────────────────────────────────────────────
	t.Run("restart_with_open_orders_no_duplicate_reservation", func(t *testing.T) {
		// Snapshot at startup has 1 open order per account
		snapWithOrders := buildSnapshotResponse(accIDs[:3], 50, true)

		store := portfolio.NewStore()
		store.Replace(snapWithOrders)

		// Verify open orders are loaded from snapshot
		acc, ok := store.Account(accIDs[0])
		if !ok {
			t.Fatalf("Account %s not in store", accIDs[0])
		}
		if len(acc.OpenOrders) != 1 {
			t.Fatalf("Expected 1 open order after snapshot, got %d", len(acc.OpenOrders))
		}
		if acc.OpenOrders[0].ClientOrderID != "coid-"+accIDs[0] {
			t.Errorf("Wrong ClientOrderID: %s", acc.OpenOrders[0].ClientOrderID)
		}

		// Apply the SAME event a second time (duplicate EventID) — must be silently ignored
		dupEvent := portfolio.Event{
			EventID:   "dup-evt-001",
			Sequence:  51,
			AccountID: accIDs[0],
			EventType: "order_placed",
		}
		if err := store.Apply(dupEvent); err != nil {
			t.Fatalf("First apply of dup event: %v", err)
		}
		if store.LastSequence() != 51 {
			t.Errorf("Expected lastSequence=51, got %d", store.LastSequence())
		}
		// Second apply of same EventID — idempotent, must not error
		if err := store.Apply(dupEvent); err != nil {
			t.Fatalf("Duplicate event must be silently ignored, got: %v", err)
		}
		// Sequence must NOT advance for duplicate
		if store.LastSequence() != 51 {
			t.Errorf("Duplicate event must not advance lastSequence; got %d", store.LastSequence())
		}
	})

	// ──────────────────────────────────────────────────────────────────────────
	// EXIT CRITERIA (bonus): BEI per-endpoint freshness thresholds override
	// ──────────────────────────────────────────────────────────────────────────
	t.Run("bei_per_endpoint_freshness_thresholds", func(t *testing.T) {
		bc := bei.NewClient(ts.URL, "test")
		bc.SetFreshnessThresholds(bei.FreshnessThresholds{
			SessionMaxAge: 5 * time.Second,
			RulesMaxAge:   5 * time.Second,
			FeesMaxAge:    5 * time.Second,
			MDXMaxAge:     5 * time.Second,
		})
		if err := bc.FetchData(ctx); err != nil {
			t.Fatalf("BEI FetchData: %v", err)
		}
		// Immediately after fetch: not stale
		if bc.IsSessionStale() {
			t.Fatal("Session should not be stale immediately after fetch")
		}
		if bc.IsMDXStale() {
			t.Fatal("MDX should not be stale immediately after fetch")
		}
		// Without time travel, we can't test expiry inline.
		// But we verify IsStale() = IsSessionStale || IsRulesStale || IsFeesStale
		if bc.IsStale() != (bc.IsSessionStale() || bc.IsRulesStale() || bc.IsFeesStale()) {
			t.Fatal("IsStale() must equal conjunction of critical endpoint staleness")
		}
	})
}

// isNormalClose returns true if the WebSocket error represents a normal closure.
// nhooyr.io/websocket returns a *websocket.CloseError for server-initiated closes.
// StatusNormalClosure (1000) and StatusGoingAway (1001) are both accepted as normal.
func isNormalClose(err error) bool {
	if err == nil {
		return true
	}
	if status := websocket.CloseStatus(err); status == websocket.StatusNormalClosure || status == websocket.StatusGoingAway {
		return true
	}
	msg := err.Error()
	return containsStr(msg, "normal") || containsStr(msg, "EOF") ||
		containsStr(msg, "use of closed network") || containsStr(msg, "closed pipe")
}

// containsStr is a simple substring check.
func containsStr(s, sub string) bool {
	if len(sub) > len(s) {
		return false
	}
	for i := 0; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
