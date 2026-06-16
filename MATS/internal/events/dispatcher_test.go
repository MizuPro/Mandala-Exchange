package events

import (
	"context"
	"testing"
	"time"

	"mandala-exchange/mats/internal/domain"
	"mandala-exchange/mats/internal/persistence"
	"mandala-exchange/mats/internal/sequence"
)

func TestDispatcherMovesMissingSekuritasEndpointToDeadLetter(t *testing.T) {
	ctx := context.Background()
	store := persistence.NewMemoryStore()
	dispatcher := NewDispatcher(store, sequence.NewAtomic(0), nil, nil, Config{MaxAttempts: 1}, nil)

	dispatcher.PublishOrderStatus(ctx, &domain.Order{
		ID:                "MATS-O-1",
		ClientOrderID:     "CLIENT-1",
		Symbol:            "MNDL",
		Status:            domain.OrderStatusOpen,
		RemainingQuantity: 100,
		UpdatedAt:         time.Now().UTC(),
	})

	events, err := store.ListDeliveryEvents(ctx, "dead", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 {
		t.Fatalf("expected 1 dead-letter event, got %d", len(events))
	}
	if events[0].EventType != TypeOrderStatus {
		t.Fatalf("expected order status event, got %s", events[0].EventType)
	}
}
