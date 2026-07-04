package session_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"mandala-exchange/mats/internal/bei"
	"mandala-exchange/mats/internal/domain"
	"mandala-exchange/mats/internal/events"
	"mandala-exchange/mats/internal/marketdata"
	"mandala-exchange/mats/internal/matching"
	"mandala-exchange/mats/internal/orders"
	"mandala-exchange/mats/internal/persistence"
	"mandala-exchange/mats/internal/rules"
	"mandala-exchange/mats/internal/sequence"
	"mandala-exchange/mats/internal/session"
)

type recordedCall struct {
	Path   string
	Method string
	Body   string
}

func TestSessionClosedSegmentDurationAndTransitionRegression(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var mu sync.Mutex
	var activeInst *bei.SessionInstance
	var finalizedID string
	var calls []recordedCall

	// Mock BEI Server
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		mu.Lock()
		defer mu.Unlock()

		// Catat panggilan
		var bodyBytes []byte
		if r.Body != nil {
			decoder := json.NewDecoder(r.Body)
			var bodyMap map[string]any
			if err := decoder.Decode(&bodyMap); err == nil {
				bodyBytes, _ = json.Marshal(bodyMap)
			}
		}
		calls = append(calls, recordedCall{
			Path:   r.URL.Path,
			Method: r.Method,
			Body:   string(bodyBytes),
		})

		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/integration/mats/securities":
			w.Write([]byte(`[{"symbol":"MNDL","board":"main","status":"listed","market_mechanism":"regular","reference_price":"100","previous_close":"100","shares_outstanding":"1000000","active_notations":[]}]`))
		case r.Method == http.MethodGet && r.URL.Path == "/v1/integration/mats/rules":
			w.Write([]byte(`[{"id":"rule-main","name":"Main","board":"main","market_segment":"regular","is_default":true,"lot_size_rules":[{"lot_size":100}],"tick_size_rules":[{"min_price":"1","tick_size":"1"}],"price_band_rules":[{"min_reference_price":"1","ara_percent":"10","arb_percent":"10","min_price":"1"}],"auto_rejection_rules":[{"max_lots_per_order":1000}]}]`))
		case r.Method == http.MethodGet && r.URL.Path == "/v1/integration/mats/sessions/active":
			// Kita buat template kustom: pre_open (1s) -> post_closing (2s) -> closed (3s)
			w.Write([]byte(`{
				"id": "template-123",
				"name": "Mandala Looping 5-Min Session",
				"status": "pre_open",
				"settlement_mode": "end_of_session",
				"settlement_delay_sessions": 0,
				"post_closing_enabled": true,
				"is_active": true,
				"segments": [
					{"sequence": 1, "status": "pre_open", "duration_seconds": 1, "allow_order_entry": true, "allow_cancel_amend": true},
					{"sequence": 2, "status": "post_closing", "duration_seconds": 2, "allow_order_entry": true, "allow_cancel_amend": false},
					{"sequence": 3, "status": "closed", "duration_seconds": 3, "allow_order_entry": false, "allow_cancel_amend": false}
				]
			}`))
		case r.Method == http.MethodGet && r.URL.Path == "/v1/integration/mats/sessions/instance/active":
			if activeInst != nil && activeInst.ID != finalizedID {
				json.NewEncoder(w).Encode(activeInst)
			} else {
				w.Write([]byte("null"))
			}
		case r.Method == http.MethodPost && r.URL.Path == "/v1/integration/mats/sessions/instance/activate":
			activeInst = &bei.SessionInstance{
				ID:                     "instance-456",
				SessionTemplateID:      "template-123",
				TemplateName:           "Mandala Looping 5-Min Session",
				SettlementMode:         "end_of_session",
				VirtualDayIndex:        0,
				Status:                 "pre_open",
				CurrentSegmentSequence: 0,
				VirtualDurationSeconds: 28800,
				RealDurationSeconds:    6,
				Version:                1,
			}
			json.NewEncoder(w).Encode(activeInst)
		case r.Method == http.MethodPost && r.URL.Path == "/v1/integration/mats/sessions/instance/progress":
			var payload bei.UpdateSessionInstanceProgressPayload
			json.Unmarshal(bodyBytes, &payload)
			if activeInst != nil && activeInst.ID == payload.InstanceID {
				activeInst.Status = payload.Status
				activeInst.CurrentSegmentSequence = payload.CurrentSegmentSequence
				activeInst.RealTimeRemainingSecs = &payload.RealTimeRemainingSeconds
			}
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{}`))
		case r.Method == http.MethodPost && r.URL.Path == "/v1/integration/mats/sessions/active/status":
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{}`))
		case r.Method == http.MethodPost && r.URL.Path == "/v1/integration/mats/sessions/instance/finalize":
			var payload bei.FinalizeSessionPayload
			json.Unmarshal(bodyBytes, &payload)
			finalizedID = payload.InstanceID
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{"id":"instance-456","status":"closed","already_finalized":false}`))
		case r.Method == http.MethodGet && r.URL.Path == "/v1/brokers/MDLA/validate":
			w.Write([]byte(`{"valid":true}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer ts.Close()

	// Inisialisasi komponen MATS
	store := persistence.NewMemoryStore()
	seq := sequence.NewAtomic(0)
	beiClient := bei.NewClient(ts.URL+"/v1", "test-bei-token")
	rulesCache := rules.NewCache(beiClient)
	if err := rulesCache.Refresh(ctx); err != nil {
		t.Fatalf("rules refresh: %v", err)
	}

	hub := marketdata.NewHub()
	engine := matching.NewEngine(seq, "template-123", marketdata.NewSummaryStore())
	hub.SetProviders(engine, rulesCache)
	dispatcher := events.NewDispatcher(store, seq, beiClient, hub, events.Config{
		SekuritasEventsURL:    "",
		SekuritasServiceToken: "",
		MaxAttempts:           1,
	}, nil)

	orderService := orders.NewService(engine, store, seq, rulesCache, orders.NewBEIBrokerValidator(beiClient))
	orderService.SetDispatcher(dispatcher)

	sessionController := session.NewController(rulesCache, orderService, dispatcher)
	daemon := session.NewDaemon(sessionController, nil)

	// Mock clock
	mockTime := time.Date(2026, 7, 4, 13, 0, 0, 0, time.UTC)
	daemon.SetClock(
		func() time.Time { return mockTime },
		func(t time.Time) time.Duration { return mockTime.Sub(t) },
	)

	// --- Jalankan Siklus Pengujian ---

	// 1. Tick pertama: inisialisasi sesi, buat instance sesi, segmen awal pre_open (Sequence 0, durasi 1s)
	daemon.Tick(ctx)

	// Verifikasi status awal
	if daemon.GetSessionSegmentStatus() != domain.SessionPreOpen {
		t.Fatalf("expected initial segment PreOpen, got %s", daemon.GetSessionSegmentStatus())
	}

	// 2. Maju 1 detik (agar pre_open berakhir) -> transisi ke post_closing (Sequence 1, durasi 2s)
	mockTime = mockTime.Add(1 * time.Second)
	daemon.Tick(ctx)

	if daemon.GetSessionSegmentStatus() != domain.SessionPostClosing {
		t.Fatalf("expected transition to PostClosing, got %s", daemon.GetSessionSegmentStatus())
	}

	// 3. Maju 1 detik lagi (post_closing baru jalan 1 detik, sisa 1 detik) -> segmen tetap post_closing
	mockTime = mockTime.Add(1 * time.Second)
	daemon.Tick(ctx)

	if daemon.GetSessionSegmentStatus() != domain.SessionPostClosing {
		t.Fatalf("expected segment to remain PostClosing, got %s", daemon.GetSessionSegmentStatus())
	}

	// 4. Maju 1 detik lagi (post_closing berakhir, total 2 detik) -> transisi ke closed (Sequence 2, durasi 3s)
	mockTime = mockTime.Add(1 * time.Second)
	daemon.Tick(ctx)

	if daemon.GetSessionSegmentStatus() != domain.SessionClosed {
		t.Fatalf("expected transition to Closed segment, got %s", daemon.GetSessionSegmentStatus())
	}

	// 5. Maju 1 detik di segmen closed (baru jalan 1 detik, sisa 2 detik) -> segmen tetap closed
	mockTime = mockTime.Add(1 * time.Second)
	daemon.Tick(ctx)

	if daemon.GetSessionSegmentStatus() != domain.SessionClosed {
		t.Fatalf("expected segment to remain Closed, got %s", daemon.GetSessionSegmentStatus())
	}

	// 6. Maju 2 detik lagi di segmen closed (total 3 detik di closed) -> segmen closed berakhir, sesi difinalisasi
	mockTime = mockTime.Add(2 * time.Second)
	daemon.Tick(ctx)

	// Di tick ini, segmen closed telah berakhir. Sesi asinkron untuk memfinalisasi dimulai.
	// Kita tunggu sejenak agar goroutine syncSessionClosedWithRetry selesai
	time.Sleep(100 * time.Millisecond)

	// 7. Tick berikutnya: karena sesi 1 sudah berakhir dan diset nil, sesi baru (sesi 2) dibuat dan dimulai dari pre_open lagi
	daemon.Tick(ctx)

	if daemon.GetSessionSegmentStatus() != domain.SessionPreOpen {
		t.Fatalf("expected rollover to new session starting with PreOpen, got %s", daemon.GetSessionSegmentStatus())
	}

	// --- Analisis Urutan Call API ke BEI ---
	mu.Lock()
	defer mu.Unlock()

	var finalizeCalled bool
	var closedProgressCalls int

	for _, call := range calls {
		if call.Path == "/v1/integration/mats/sessions/instance/finalize" {
			finalizeCalled = true
		}
		if call.Path == "/v1/integration/mats/sessions/instance/progress" && strings.Contains(call.Body, `"status":"closed"`) {
			closedProgressCalls++
		}
	}

	if !finalizeCalled {
		t.Error("expected sessions/instance/finalize to be called")
	}

	// Progress "closed" dipublikasikan (sekali di awal transisi, dan selama tick di dalam segmen closed)
	if closedProgressCalls < 2 {
		t.Errorf("expected closed progress update to be published to BEI, got %d calls", closedProgressCalls)
	}
}
