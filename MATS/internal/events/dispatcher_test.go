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

func TestDeadLetterEventCanBeRequeued(t *testing.T) {
	ctx := context.Background()
	store := persistence.NewMemoryStore()
	dispatcher := NewDispatcher(store, sequence.NewAtomic(0), nil, nil, Config{MaxAttempts: 1}, nil)

	dispatcher.PublishOrderStatus(ctx, &domain.Order{
		ID:                "MATS-O-2",
		ClientOrderID:     "CLIENT-2",
		Symbol:            "TEST",
		Status:            domain.OrderStatusOpen,
		RemainingQuantity: 200,
		UpdatedAt:         time.Now().UTC(),
	})

	deadEvents, err := store.ListDeliveryEvents(ctx, "dead", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(deadEvents) != 1 {
		t.Fatalf("expected 1 dead event, got %d", len(deadEvents))
	}

	requeued, err := store.RequeueDeadDeliveryEvent(ctx, deadEvents[0].ID)
	if err != nil {
		t.Fatalf("requeue failed: %v", err)
	}
	if requeued.Status != "pending" {
		t.Fatalf("expected pending status after requeue, got %s", requeued.Status)
	}
	if requeued.LastError != "" {
		t.Fatalf("expected empty last_error after requeue, got %s", requeued.LastError)
	}
	if requeued.MaxAttempts != 4 {
		t.Fatalf("expected max_attempts=4 (1+3), got %d", requeued.MaxAttempts)
	}

	pendingEvents, err := store.ListDeliveryEvents(ctx, "pending", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(pendingEvents) != 1 {
		t.Fatalf("expected 1 pending event after requeue, got %d", len(pendingEvents))
	}

	// Requeue a non-dead event should fail
	_, err = store.RequeueDeadDeliveryEvent(ctx, deadEvents[0].ID)
	if err == nil {
		t.Fatal("expected error when requeuing non-dead event")
	}
}
