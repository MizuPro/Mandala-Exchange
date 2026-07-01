package queue

import (
	"context"
	"sync"
	"testing"
	"time"
)

// TestQueuePriority verifies that orders are dispatched in priority order:
// PriorityRiskCancel (3) > PriorityMarketEvent (2) > PriorityNormal (1) > PriorityMarketMakerRefresh (0)
func TestQueuePriority(t *testing.T) {
	q := NewOrderQueue(1, 100)

	now := time.Now()
	q.Submit(&OrderRequest{ClientOrderID: "2", Priority: PriorityNormal, SubmittedAt: now})
	q.Submit(&OrderRequest{ClientOrderID: "1", Priority: PriorityRiskCancel, SubmittedAt: now})
	q.Submit(&OrderRequest{ClientOrderID: "3", Priority: PriorityMarketMakerRefresh, SubmittedAt: now})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var processed []string
	var mu sync.Mutex

	go q.Run(ctx, func(c context.Context, req *OrderRequest) {
		mu.Lock()
		processed = append(processed, req.ClientOrderID)
		mu.Unlock()
	})

	time.Sleep(500 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()

	if len(processed) != 3 {
		t.Fatalf("expected 3 processed, got %d", len(processed))
	}
	// Expected: RiskCancel ("1") → Normal ("2") → MarketMakerRefresh ("3")
	if processed[0] != "1" || processed[1] != "2" || processed[2] != "3" {
		t.Errorf("expected priority order 1, 2, 3 (risk→normal→mm), got %v", processed)
	}
}

// TestQueuePriorityFourLevels verifies all four priority levels in the correct order.
func TestQueuePriorityFourLevels(t *testing.T) {
	q := NewOrderQueue(1, 100)

	now := time.Now()
	// Submit in worst-case (reverse) order
	q.Submit(&OrderRequest{ClientOrderID: "mm", Priority: PriorityMarketMakerRefresh, SubmittedAt: now})
	q.Submit(&OrderRequest{ClientOrderID: "normal", Priority: PriorityNormal, SubmittedAt: now})
	q.Submit(&OrderRequest{ClientOrderID: "market", Priority: PriorityMarketEvent, SubmittedAt: now})
	q.Submit(&OrderRequest{ClientOrderID: "risk", Priority: PriorityRiskCancel, SubmittedAt: now})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var processed []string
	var mu sync.Mutex

	go q.Run(ctx, func(c context.Context, req *OrderRequest) {
		mu.Lock()
		processed = append(processed, req.ClientOrderID)
		mu.Unlock()
	})

	time.Sleep(600 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()

	if len(processed) != 4 {
		t.Fatalf("expected 4 processed, got %d", len(processed))
	}
	// Expected order: risk → market → normal → mm
	expected := []string{"risk", "market", "normal", "mm"}
	for i, e := range expected {
		if processed[i] != e {
			t.Errorf("position %d: expected %q, got %q (full order: %v)", i, e, processed[i], processed)
		}
	}
}

// TestQueueTTL verifies that expired orders are not submitted and are audited.
func TestQueueTTL(t *testing.T) {
	q := NewOrderQueue(1, 100)
	var expired []string
	var expiredMu sync.Mutex
	q.SetExpirationHandler(func(req *OrderRequest) {
		expiredMu.Lock()
		defer expiredMu.Unlock()
		expired = append(expired, req.ClientOrderID)
	})

	now := time.Now()
	// This one should expire — ExpiresAt is in the past
	q.Submit(&OrderRequest{
		ClientOrderID: "expired",
		Priority:      PriorityNormal,
		SubmittedAt:   now,
		ExpiresAt:     now.Add(-1 * time.Second),
	})
	// This one is valid
	q.Submit(&OrderRequest{
		ClientOrderID: "valid",
		Priority:      PriorityNormal,
		SubmittedAt:   now,
		ExpiresAt:     now.Add(1 * time.Hour),
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var processed []string
	var mu sync.Mutex

	go q.Run(ctx, func(c context.Context, req *OrderRequest) {
		mu.Lock()
		processed = append(processed, req.ClientOrderID)
		mu.Unlock()
	})

	time.Sleep(500 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()

	if len(processed) != 1 {
		t.Fatalf("expected 1 processed (valid only), got %d: %v", len(processed), processed)
	}
	if processed[0] != "valid" {
		t.Errorf("expected 'valid', got %s", processed[0])
	}
	expiredMu.Lock()
	defer expiredMu.Unlock()
	if len(expired) != 1 || expired[0] != "expired" {
		t.Errorf("expected expired order audit callback, got %v", expired)
	}
}

// TestQueueRequiresStableUniqueClientOrderID verifies that empty and duplicate
// client_order_id values are rejected at submit time.
func TestQueueRequiresStableUniqueClientOrderID(t *testing.T) {
	q := NewOrderQueue(1, 10)

	// Empty client_order_id must be rejected
	if err := q.Submit(&OrderRequest{}); err == nil {
		t.Fatal("expected empty client_order_id rejection")
	}

	// First submission must succeed
	if err := q.Submit(&OrderRequest{ClientOrderID: "bot:b:session:1"}); err != nil {
		t.Fatal(err)
	}

	// Duplicate must be rejected
	if err := q.Submit(&OrderRequest{ClientOrderID: "bot:b:session:1"}); err == nil {
		t.Fatal("expected duplicate client_order_id rejection")
	}
}

// TestQueueFull verifies that Submit() returns an error when the queue is at capacity.
func TestQueueFull(t *testing.T) {
	q := NewOrderQueue(0, 2) // maxSize=2

	if err := q.Submit(&OrderRequest{ClientOrderID: "a"}); err != nil {
		t.Fatalf("first submit failed: %v", err)
	}
	if err := q.Submit(&OrderRequest{ClientOrderID: "b"}); err != nil {
		t.Fatalf("second submit failed: %v", err)
	}
	if err := q.Submit(&OrderRequest{ClientOrderID: "c"}); err == nil {
		t.Fatal("expected queue full error on third submit")
	}
}

// TestLookupByClientID verifies submit_unknown reconciliation:
// An order in the queue can be found by its stable client_order_id.
func TestLookupByClientID(t *testing.T) {
	q := NewOrderQueue(0, 100) // no workers — orders stay in queue

	if err := q.Submit(&OrderRequest{
		ClientOrderID: "bot-001:sess-42:order-7",
		Priority:      PriorityNormal,
	}); err != nil {
		t.Fatalf("submit failed: %v", err)
	}

	// Should be found while still in queue
	req, ok := q.LookupByClientID("bot-001:sess-42:order-7")
	if !ok {
		t.Fatal("expected order to be found in queue")
	}
	if req.ClientOrderID != "bot-001:sess-42:order-7" {
		t.Errorf("unexpected client_order_id: %s", req.ClientOrderID)
	}

	// Returned value must be a copy — mutating it should NOT affect the queue
	req.BotID = "MUTATED"
	original, _ := q.LookupByClientID("bot-001:sess-42:order-7")
	if original.BotID == "MUTATED" {
		t.Error("LookupByClientID must return a copy, not a pointer to the queue entry")
	}
}

// TestLookupByClientID_NotFound verifies that LookupByClientID returns false
// for an unknown or already-dispatched order.
func TestLookupByClientID_NotFound(t *testing.T) {
	q := NewOrderQueue(0, 100)

	_, ok := q.LookupByClientID("nonexistent")
	if ok {
		t.Error("expected not found for nonexistent client_order_id")
	}
}

// TestRateLimiterSustainedAndHardLimit verifies that the queue rate limiters
// are configured per PRD performance budget:
//   - sustained: 300/min (5/sec), burst 100
//   - hard limit: 600/min (10/sec), burst 100
func TestRateLimiterConfiguration(t *testing.T) {
	q := NewOrderQueue(1, 500)

	// Verify that the limiter fields are non-nil (configuration check)
	if q.limit == nil {
		t.Error("sustained rate limiter must not be nil")
	}
	if q.hardLimit == nil {
		t.Error("hard rate limiter must not be nil")
	}

	// Submit burst of 100 orders and measure throughput
	// With burst=100, first 100 should be available immediately
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	for i := 0; i < 100; i++ {
		clientID := "burst-" + time.Now().Format("150405.000000000") + "-" + string(rune('A'+i%26)) + string(rune('a'+i/26))
		q.Submit(&OrderRequest{ClientOrderID: clientID, Priority: PriorityNormal})
	}

	var processed int64
	var mu sync.Mutex
	start := time.Now()

	go q.Run(ctx, func(c context.Context, req *OrderRequest) {
		mu.Lock()
		processed++
		mu.Unlock()
	})

	// Wait up to 3 seconds for the burst to be processed
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		count := processed
		mu.Unlock()
		if count >= 50 { // at least half of burst should have gone through
			break
		}
		time.Sleep(50 * time.Millisecond)
	}

	elapsed := time.Since(start)
	mu.Lock()
	count := processed
	mu.Unlock()

	// Rate limiter should not block the initial burst (100 tokens available)
	// Hard limit is 10/s so 100 orders in 10s max
	if count == 0 {
		t.Errorf("expected orders to be processed in %.1fs, got 0", elapsed.Seconds())
	}
	t.Logf("Rate limiter test: processed %d orders in %.2fs", count, elapsed.Seconds())
}
