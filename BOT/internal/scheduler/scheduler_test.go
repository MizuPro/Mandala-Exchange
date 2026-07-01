package scheduler

import (
	"context"
	"sync"
	"testing"
	"time"
)

// TestScheduler verifies that due tasks are dispatched and future tasks are deferred.
func TestScheduler(t *testing.T) {
	s := NewScheduler(2)

	var processed []string
	var mu sync.Mutex

	now := time.Now()

	// Task that runs immediately
	s.Schedule(&Task{
		BotID:     "bot1",
		ExecuteAt: now,
		Handler: func(ctx context.Context, botID string, payload interface{}) error {
			mu.Lock()
			processed = append(processed, botID)
			mu.Unlock()
			return nil
		},
	})

	// Task that runs in future — must NOT be dispatched this tick
	s.Schedule(&Task{
		BotID:     "bot2",
		ExecuteAt: now.Add(1 * time.Hour),
		Handler: func(ctx context.Context, botID string, payload interface{}) error {
			mu.Lock()
			processed = append(processed, botID)
			mu.Unlock()
			return nil
		},
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go s.Run(ctx)

	time.Sleep(500 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()

	if len(processed) != 1 {
		t.Fatalf("expected 1 task processed, got %d", len(processed))
	}
	if processed[0] != "bot1" {
		t.Errorf("expected bot1 to run, got %s", processed[0])
	}
}

// TestSchedulerPanicIsolation verifies that a panicking task does not kill the worker.
func TestSchedulerPanicIsolation(t *testing.T) {
	s := NewScheduler(2)

	var safeRan bool
	var mu sync.Mutex

	now := time.Now()

	// This task panics — should not affect the next task
	s.Schedule(&Task{
		BotID:     "panic-bot",
		ExecuteAt: now,
		Handler: func(ctx context.Context, botID string, payload interface{}) error {
			panic("simulated strategy panic")
		},
	})

	// This task should still run despite the panic above
	s.Schedule(&Task{
		BotID:     "safe-bot",
		ExecuteAt: now,
		Handler: func(ctx context.Context, botID string, payload interface{}) error {
			mu.Lock()
			safeRan = true
			mu.Unlock()
			return nil
		},
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go s.Run(ctx)

	time.Sleep(500 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()

	if !safeRan {
		t.Error("safe-bot should have run despite panic in panic-bot")
	}
}

// TestSnapshotStoreImmutability verifies that Get() returns a value copy,
// so callers cannot mutate the stored snapshot.
func TestSnapshotStoreImmutability(t *testing.T) {
	store := NewSnapshotStore()

	original := MarketSnapshot{Symbol: "BBCA", Price: 10000, LastUpdate: time.Now()}
	store.Publish(original)

	snap, ok := store.Get("BBCA")
	if !ok {
		t.Fatal("expected snapshot to exist")
	}
	if snap.Price != 10000 {
		t.Errorf("expected price 10000, got %d", snap.Price)
	}

	// Mutate the retrieved copy — should NOT affect the stored snapshot
	snap.Price = 99999
	stored, _ := store.Get("BBCA")
	if stored.Price != 10000 {
		t.Errorf("stored snapshot should not be mutated; got price %d", stored.Price)
	}
}

// TestSnapshotStorePublishReplaces verifies that Publish() atomically replaces
// the snapshot for a symbol.
func TestSnapshotStorePublishReplaces(t *testing.T) {
	store := NewSnapshotStore()

	store.Publish(MarketSnapshot{Symbol: "TLKM", Price: 5000})
	store.Publish(MarketSnapshot{Symbol: "TLKM", Price: 5100})

	snap, ok := store.Get("TLKM")
	if !ok {
		t.Fatal("expected snapshot to exist")
	}
	if snap.Price != 5100 {
		t.Errorf("expected latest price 5100, got %d", snap.Price)
	}
}

// TestSnapshotStoreUnknownSymbol verifies that Get() returns false for unknown symbols.
func TestSnapshotStoreUnknownSymbol(t *testing.T) {
	store := NewSnapshotStore()
	_, ok := store.Get("UNKNOWN")
	if ok {
		t.Error("expected ok=false for unknown symbol")
	}
}

func TestSchedulerAssignsStableOrderForEqualExecutionTime(t *testing.T) {
	scheduler := NewScheduler(1)
	executeAt := time.Now().Add(time.Hour)
	first := &Task{BotID: "same-bot", ExecuteAt: executeAt}
	second := &Task{BotID: "same-bot", ExecuteAt: executeAt}
	scheduler.Schedule(first)
	scheduler.Schedule(second)
	if first.Sequence != 1 || second.Sequence != 2 {
		t.Fatalf("unstable scheduler sequence: first=%d second=%d", first.Sequence, second.Sequence)
	}
	if scheduler.queue[0] != first {
		t.Fatal("heap did not preserve scheduler ordering for equal execution time")
	}
}

// TestSchedulerBoundedDispatch verifies that dispatch() is non-blocking
// when the task channel is full, leaving tasks in the queue.
func TestSchedulerBoundedDispatch(t *testing.T) {
	s := NewScheduler(1) // 1 worker, channel capacity = workers*50 = 50
	// Do not start Run() — we test dispatch() directly with a tiny channel
	taskCh := make(chan *Task, 1) // tiny channel to force backpressure

	// Use ExecuteAt well in the past to ensure tasks are due even after jitter (max 100ms)
	past := time.Now().Add(-5 * time.Second)
	for i := 0; i < 5; i++ {
		s.Schedule(&Task{
			BotID:     "bot",
			ExecuteAt: past,
			Handler: func(ctx context.Context, botID string, payload interface{}) error {
				return nil
			},
		})
	}

	// Dispatch with a 1-capacity channel — only 1 task should be sent (backpressure)
	s.dispatch(taskCh)

	if len(taskCh) != 1 {
		t.Errorf("expected 1 task in channel after backpressure, got %d", len(taskCh))
	}
	// Remaining 4 tasks must still be in the heap
	s.mu.Lock()
	remaining := s.queue.Len()
	s.mu.Unlock()
	if remaining != 4 {
		t.Errorf("expected 4 tasks remaining in heap after backpressure, got %d", remaining)
	}
}
