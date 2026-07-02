package queue

import (
	"container/heap"
	"context"
	"errors"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// Priority levels for the order queue.
// Higher numeric value = higher dispatch priority (Less() uses > for max-heap behavior).
//
// Priority ordering per PRD:
//   - PriorityRiskCancel (3)   — risk management / cancel: highest
//   - PriorityMarketEvent (2)  — market event reactions
//   - PriorityNormal (1)       — regular strategy orders
//   - PriorityMarketMakerRefresh (0) — quote refresh: lowest
type Priority int

const (
	PriorityMarketMakerRefresh Priority = iota // 0 — lowest
	PriorityNormal                             // 1
	PriorityMarketEvent                        // 2
	PriorityRiskCancel                         // 3 — highest
)

// OrderRequest represents a single order in the priority queue.
type OrderRequest struct {
	ClientOrderID string
	BotID         string
	Priority      Priority
	Payload       interface{}
	SubmittedAt   time.Time
	ExpiresAt     time.Time
}

type SubmitOrderPayload struct {
	AccountID string
	Symbol    string
	Side      string
	PriceIDR  int64
	Quantity  int64
}

type CancelOrderPayload struct {
	AccountID     string
	ClientOrderID string
}

type orderHeap []*OrderRequest

func (h orderHeap) Len() int { return len(h) }
func (h orderHeap) Less(i, j int) bool {
	// Higher priority first (max-heap)
	if h[i].Priority != h[j].Priority {
		return h[i].Priority > h[j].Priority
	}
	// For equal priority, older submissions go first (FIFO within priority)
	return h[i].SubmittedAt.Before(h[j].SubmittedAt)
}
func (h orderHeap) Swap(i, j int)       { h[i], h[j] = h[j], h[i] }
func (h *orderHeap) Push(x interface{}) { *h = append(*h, x.(*OrderRequest)) }
func (h *orderHeap) Pop() interface{} {
	old := *h
	n := len(old)
	item := old[n-1]
	*h = old[0 : n-1]
	return item
}

// OrderQueue is a priority order queue with:
//   - 4 priority levels (risk/cancel > market/event > normal > market-maker refresh)
//   - Sustained rate limit: 300/min (5/sec)
//   - Burst capacity: 100 per 10 seconds
//   - Hard limit: 600/min (10/sec)
//   - Max queue size: 5000
//   - Per-entry TTL (expired_before_submit enforcement)
//   - Stable client_order_id: required; duplicates rejected
//   - LookupByClientID: for submit_unknown reconciliation
type OrderQueue struct {
	mu        sync.Mutex
	items     orderHeap
	limit     *rate.Limiter
	hardLimit *rate.Limiter
	workers   int
	maxSize   int
	lookups   map[string]*OrderRequest
	onExpired func(*OrderRequest)
	signal    chan struct{}
}

// SetExpirationHandler wires the expired_before_submit audit path. Configure it
// during startup before Run.
func (q *OrderQueue) SetExpirationHandler(handler func(*OrderRequest)) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.onExpired = handler
}

// NewOrderQueue creates an OrderQueue with the given worker count and max size.
// Per PRD performance budget:
//   - sustained: 300/min = 5/sec, burst: 100
//   - hard limit: 600/min = 10/sec, burst: 100
//   - max queue: 5000
//   - workers: 10
func NewOrderQueue(workers int, maxSize int) *OrderQueue {
	// Sustained 300/min = 5/sec with burst 100 (100 orders per 10s burst window)
	limiter := rate.NewLimiter(rate.Limit(5), 100)
	// Hard limit 600/min = 10/sec
	hardLimit := rate.NewLimiter(rate.Limit(10), 100)

	return &OrderQueue{
		items:     make(orderHeap, 0),
		limit:     limiter,
		hardLimit: hardLimit,
		workers:   workers,
		maxSize:   maxSize,
		lookups:   make(map[string]*OrderRequest),
		signal:    make(chan struct{}, maxSize+1000), // extra buffer for risk bypass
	}
}

// Submit enqueues an order. Returns an error if:
//   - The queue is full (5000 capacity)
//   - ClientOrderID is empty (stable ID required)
//   - ClientOrderID is a duplicate (prevents duplicate submission)
func (q *OrderQueue) Submit(req *OrderRequest) error {
	q.mu.Lock()
	defer q.mu.Unlock()

	// Risk/Cancel orders bypass the max size to prevent catastrophic drops.
	if len(q.items) >= q.maxSize && req.Priority < PriorityRiskCancel {
		return errors.New("queue full")
	}
	if req.ClientOrderID == "" {
		return errors.New("stable client_order_id is required")
	}
	if _, duplicate := q.lookups[req.ClientOrderID]; duplicate {
		return errors.New("duplicate client_order_id")
	}
	req.SubmittedAt = time.Now()

	heap.Push(&q.items, req)
	q.lookups[req.ClientOrderID] = req
	
	select {
	case q.signal <- struct{}{}:
	default:
	}
	return nil
}

// LookupByClientID retrieves an in-queue order by its stable client_order_id.
// This is used for submit_unknown reconciliation: after an HTTP timeout, the bot
// looks up whether the order is still queued (not yet submitted) to avoid blind retry.
// Returns nil if the order is not found (already dispatched, expired, or never queued).
func (q *OrderQueue) LookupByClientID(clientOrderID string) (*OrderRequest, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	req, ok := q.lookups[clientOrderID]
	if !ok {
		return nil, false
	}
	// Return a copy to prevent external mutation of the queue entry
	copy := *req
	return &copy, true
}

// Run starts the worker goroutines. Blocks until ctx is cancelled, then drains the queue.
func (q *OrderQueue) Run(ctx context.Context, handler func(context.Context, *OrderRequest)) {
	var wg sync.WaitGroup
	for i := 0; i < q.workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			q.worker(ctx, handler)
		}()
	}
	// Block until context is cancelled and workers exit
	wg.Wait()

	// Graceful Shutdown Drain: process all remaining orders in the queue
	q.mu.Lock()
	for len(q.items) > 0 {
		req := heap.Pop(&q.items).(*OrderRequest)
		delete(q.lookups, req.ClientOrderID)
		q.mu.Unlock()
		
		// Pass a background context since the original is cancelled
		handler(context.Background(), req)
		q.mu.Lock()
	}
	q.mu.Unlock()
}

func (q *OrderQueue) worker(ctx context.Context, handler func(context.Context, *OrderRequest)) {
	for {
		select {
		case <-ctx.Done():
			return // Workers exit, Run() will perform the drain
		case <-q.signal:
			// Item available
		}
		
		// Wait for sustained rate limiter
		err := q.limit.Wait(ctx)
		if err != nil {
			return
		}
		// Enforce hard limit
		err = q.hardLimit.Wait(ctx)
		if err != nil {
			return
		}

		q.mu.Lock()
		if len(q.items) == 0 {
			q.mu.Unlock()
			continue
		}

		req := heap.Pop(&q.items).(*OrderRequest)
		delete(q.lookups, req.ClientOrderID)
		q.mu.Unlock()

		// TTL check: expired_before_submit
		if !req.ExpiresAt.IsZero() && time.Now().After(req.ExpiresAt) {
			q.mu.Lock()
			onExpired := q.onExpired
			q.mu.Unlock()
			if onExpired != nil {
				copyReq := *req
				onExpired(&copyReq)
			}
			// Task expired before it could be submitted — do not send to handler
			continue
		}

		handler(ctx, req)
	}
}
