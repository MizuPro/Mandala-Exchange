package queue

import (
	"context"
	"sync"
	"testing"
	"time"
)

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
	if processed[0] != "1" || processed[1] != "2" || processed[2] != "3" {
		t.Errorf("expected 1, 2, 3 priority order, got %v", processed)
	}
}

func TestQueueTTL(t *testing.T) {
	q := NewOrderQueue(1, 100)

	now := time.Now()
	// This one should expire
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
		t.Fatalf("expected 1 processed (the valid one), got %d", len(processed))
	}
	if processed[0] != "valid" {
		t.Errorf("expected 'valid', got %s", processed[0])
	}
}

func TestQueueRequiresStableUniqueClientOrderID(t *testing.T) {
	q := NewOrderQueue(1, 10)
	if err := q.Submit(&OrderRequest{}); err == nil {
		t.Fatal("expected empty client_order_id rejection")
	}
	if err := q.Submit(&OrderRequest{ClientOrderID: "bot:b:session:1"}); err != nil {
		t.Fatal(err)
	}
	if err := q.Submit(&OrderRequest{ClientOrderID: "bot:b:session:1"}); err == nil {
		t.Fatal("expected duplicate client_order_id rejection")
	}
}
