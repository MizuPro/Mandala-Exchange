package strategystate

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPostgresRepositoryVersionedRestartAndConflict(t *testing.T) {
	databaseURL := os.Getenv("BOT_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("BOT_TEST_DATABASE_URL is required for PostgreSQL integration")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()

	botID := "strategy-state-" + uuid.NewString()
	if _, err := pool.Exec(ctx, `
		INSERT INTO bots(external_bot_id, strategy_type, status)
		VALUES ($1, 'bandar', 'active')`, botID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM bots WHERE external_bot_id=$1`, botID)
	})

	repository := NewPostgresRepository(pool)
	sessionID := uuid.New()
	initial := Snapshot{
		BotID: botID, Strategy: StrategyBandar,
		SessionInstanceID: sessionID,
		State:             json.RawMessage(`{"phase":"accumulation","inventory_lots":100}`),
		Checkpoint: Checkpoint{
			SessionInstanceID: sessionID, EventSequence: 12, SchedulerSequence: 3,
		},
		Reason: ReasonTransition,
	}
	saved, err := repository.Save(ctx, initial)
	if err != nil {
		t.Fatal(err)
	}
	if saved.StateVersion != 1 {
		t.Fatalf("expected version 1, got %d", saved.StateVersion)
	}

	stale := initial
	stale.State = json.RawMessage(`{"phase":"distribution"}`)
	if _, err := repository.Save(ctx, stale); !errors.Is(err, ErrVersionConflict) {
		t.Fatalf("expected stale writer conflict, got %v", err)
	}

	saved.State = json.RawMessage(`{"phase":"markup","inventory_lots":5000}`)
	saved.Reason = ReasonMaterialChange
	second, err := repository.Save(ctx, saved)
	if err != nil {
		t.Fatal(err)
	}
	if second.StateVersion != 2 {
		t.Fatalf("expected version 2, got %d", second.StateVersion)
	}

	concurrentA := second
	concurrentA.State = json.RawMessage(`{"phase":"distribution","inventory_lots":4500}`)
	concurrentB := second
	concurrentB.State = json.RawMessage(`{"phase":"distribution","inventory_lots":4400}`)
	results := make(chan error, 2)
	for _, candidate := range []Snapshot{concurrentA, concurrentB} {
		go func(snapshot Snapshot) {
			_, saveErr := repository.Save(ctx, snapshot)
			results <- saveErr
		}(candidate)
	}
	var successes, conflicts int
	for range 2 {
		saveErr := <-results
		switch {
		case saveErr == nil:
			successes++
		case errors.Is(saveErr, ErrVersionConflict):
			conflicts++
		default:
			t.Fatalf("unexpected concurrent save error: %v", saveErr)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("expected one winner and one conflict, successes=%d conflicts=%d", successes, conflicts)
	}

	restarted := NewManager(NewPostgresRepository(pool))
	if err := restarted.Restore(ctx); err != nil {
		t.Fatal(err)
	}
	restored, ok := restarted.Get(botID)
	if !ok {
		t.Fatal("strategy state missing after restart")
	}
	var restoredState map[string]any
	if err := json.Unmarshal(restored.State, &restoredState); err != nil {
		t.Fatal(err)
	}
	if restored.StateVersion != 3 ||
		restored.Checkpoint.EventSequence != 12 ||
		restoredState["phase"] != "distribution" {
		t.Fatalf("restart restored wrong state: %+v", restored)
	}
}
