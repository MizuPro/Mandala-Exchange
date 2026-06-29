package queue

import (
	"container/heap"
	"context"
	"errors"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

type Priority int

const (
	PriorityMarketMakerRefresh Priority = iota
	PriorityNormal
	PriorityMarketEvent
	PriorityRiskCancel
)

type OrderRequest struct {
	ClientOrderID string
	BotID         string
	Priority      Priority
	Payload       interface{}
	SubmittedAt   time.Time
	ExpiresAt     time.Time
}

type orderHeap []*OrderRequest

func (h orderHeap) Len() int { return len(h) }
func (h orderHeap) Less(i, j int) bool {
	// Higher priority first
	if h[i].Priority != h[j].Priority {
		return h[i].Priority > h[j].Priority
	}
	// Older first for same priority
	return h[i].SubmittedAt.Before(h[j].SubmittedAt)
}
func (h orderHeap) Swap(i, j int) { h[i], h[j] = h[j], h[i] }
func (h *orderHeap) Push(x interface{}) {
	*h = append(*h, x.(*OrderRequest))
}
func (h *orderHeap) Pop() interface{} {
	old := *h
	n := len(old)
	item := old[n-1]
	*h = old[0 : n-1]
	return item
}

type OrderQueue struct {
	mu        sync.Mutex
	items     orderHeap
	limit     *rate.Limiter
	hardLimit *rate.Limiter
	workers   int
	maxSize   int
	lookups   map[string]*OrderRequest
}

func NewOrderQueue(workers int, maxSize int) *OrderQueue {
	// Sustained 300/min (5/sec), burst 100
	limiter := rate.NewLimiter(rate.Limit(5), 100)
	// Hard limit 600/min (10/sec)
	hardLimit := rate.NewLimiter(rate.Limit(10), 100)

	return &OrderQueue{
		items:     make(orderHeap, 0),
		limit:     limiter,
		hardLimit: hardLimit,
		workers:   workers,
		maxSize:   maxSize,
		lookups:   make(map[string]*OrderRequest),
	}
}

func (q *OrderQueue) Submit(req *OrderRequest) error {
	q.mu.Lock()
	defer q.mu.Unlock()

	if len(q.items) >= q.maxSize {
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
	return nil
}

func (q *OrderQueue) Run(ctx context.Context, handler func(context.Context, *OrderRequest)) {
	for i := 0; i < q.workers; i++ {
		go q.worker(ctx, handler)
	}
}

func (q *OrderQueue) worker(ctx context.Context, handler func(context.Context, *OrderRequest)) {
	for {
		select {
		case <-ctx.Done():
			return
		default:
			// Wait for rate limiter
			err := q.limit.Wait(ctx)
			if err != nil {
				return
			}
			// Enforce hard limit as well
			err = q.hardLimit.Wait(ctx)
			if err != nil {
				return
			}

			q.mu.Lock()
			if len(q.items) == 0 {
				q.mu.Unlock()
				time.Sleep(10 * time.Millisecond) // avoid tight loop if empty
				continue
			}

			req := heap.Pop(&q.items).(*OrderRequest)
			delete(q.lookups, req.ClientOrderID)
			q.mu.Unlock()

			if !req.ExpiresAt.IsZero() && time.Now().After(req.ExpiresAt) {
				// expired_before_submit
				continue
			}

			handler(ctx, req)
		}
	}
}
