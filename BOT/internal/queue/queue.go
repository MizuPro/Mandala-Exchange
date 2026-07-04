package queue

import (
	"context"
	"time"

	"github.com/Mandala-Exchange/bot-v2/internal/logger"
)

type OrderDecision struct {
	Action        string // "place" (default/empty), "cancel", "amend"
	AccountID     string
	ClientOrderID string
	TargetOrderID string // sekuritas_order_id yang ingin dicancel/amend
	Symbol        string
	Side          string // "buy" | "sell"
	OrderType     string // "limit"
	Price         int64
	Quantity      int64 // in shares (not lots)
	EnqueuedAt    time.Time
	TTL           time.Duration
}

type OrderQueue struct {
	queueChan chan OrderDecision
	ttl       time.Duration
}

func NewOrderQueue(bufferSize int, defaultTTL time.Duration) *OrderQueue {
	if bufferSize <= 0 {
		bufferSize = 500
	}
	if defaultTTL <= 0 {
		defaultTTL = 30 * time.Second
	}
	return &OrderQueue{
		queueChan: make(chan OrderDecision, bufferSize),
		ttl:       defaultTTL,
	}
}

// Enqueue puts an order decision into the queue.
// If the channel is full, it drops the decision and logs a warning (backpressure).
func (q *OrderQueue) Enqueue(dec OrderDecision) bool {
	dec.EnqueuedAt = time.Now()
	if dec.TTL <= 0 {
		dec.TTL = q.ttl
	}

	select {
	case q.queueChan <- dec:
		return true
	default:
		// BACKPRESSURE: Log drop explicitly
		logger.Warn("Order queue is FULL. Dropping order decision.",
			"account_id", dec.AccountID,
			"client_order_id", dec.ClientOrderID,
			"symbol", dec.Symbol,
			"side", dec.Side,
			"qty", dec.Quantity,
			"price", dec.Price,
		)
		return false
	}
}

// Dequeue receives an order decision from the queue, blocking until one is available or context cancelled.
// It filters out stale items automatically (item age > TTL).
func (q *OrderQueue) Dequeue(ctx context.Context) (OrderDecision, error) {
	for {
		select {
		case <-ctx.Done():
			return OrderDecision{}, ctx.Err()
		case dec, ok := <-q.queueChan:
			if !ok {
				return OrderDecision{}, context.Canceled
			}

			// Stale check
			if time.Since(dec.EnqueuedAt) > dec.TTL {
				logger.Warn("Dropped stale order decision from queue",
					"account_id", dec.AccountID,
					"client_order_id", dec.ClientOrderID,
					"age", time.Since(dec.EnqueuedAt).String(),
					"ttl", dec.TTL.String(),
				)
				continue // Get next item
			}

			return dec, nil
		}
	}
}

func (q *OrderQueue) Close() {
	close(q.queueChan)
}

func (q *OrderQueue) Size() int {
	return len(q.queueChan)
}

