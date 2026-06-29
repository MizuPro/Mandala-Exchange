package scheduler

import (
	"context"
	"sync"
	"testing"
	"time"
)

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

	// Task that runs in future
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
