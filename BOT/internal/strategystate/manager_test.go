package strategystate

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"

	"github.com/google/uuid"
)

type memoryRepository struct {
	mu     sync.Mutex
	states map[string]Snapshot
	fail   map[string]error
	saves  []Snapshot
}

func newMemoryRepository(initial ...Snapshot) *memoryRepository {
	repository := &memoryRepository{
		states: make(map[string]Snapshot),
		fail:   make(map[string]error),
	}
	for _, snapshot := range initial {
		repository.states[snapshot.BotID] = clone(snapshot)
	}
	return repository
}

func (r *memoryRepository) LoadLatest(context.Context) ([]Snapshot, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	result := make([]Snapshot, 0, len(r.states))
	for _, snapshot := range r.states {
		result = append(result, clone(snapshot))
	}
	return result, nil
}

func (r *memoryRepository) Save(_ context.Context, snapshot Snapshot) (Snapshot, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.fail[snapshot.BotID]; err != nil {
		return Snapshot{}, err
	}
	if current, ok := r.states[snapshot.BotID]; ok && current.StateVersion != snapshot.StateVersion {
		return Snapshot{}, ErrVersionConflict
	}
	snapshot.StateVersion++
	r.states[snapshot.BotID] = clone(snapshot)
	r.saves = append(r.saves, clone(snapshot))
	return clone(snapshot), nil
}

func validSnapshot(botID string, strategy Strategy) Snapshot {
	sessionID := uuid.New()
	return Snapshot{
		BotID: botID, Strategy: strategy, SessionInstanceID: sessionID,
		State: json.RawMessage(`{"phase":"accumulation","inventory_lots":120}`),
		Checkpoint: Checkpoint{
			SessionInstanceID: sessionID,
			EventSequence:     42,
			SchedulerSequence: 7,
		},
		Reason: ReasonMaterialChange,
	}
}

func TestManagerPersistsTransitionAndMaterialChangeWithMonotonicVersion(t *testing.T) {
	repository := newMemoryRepository()
	manager := NewManager(repository)
	ctx := context.Background()

	first, err := manager.PersistTransition(ctx, validSnapshot("bandar-1", StrategyBandar))
	if err != nil {
		t.Fatal(err)
	}
	if first.StateVersion != 1 || first.Reason != ReasonTransition {
		t.Fatalf("unexpected first snapshot: %+v", first)
	}

	first.State = json.RawMessage(`{"phase":"markup","inventory_lots":5000}`)
	second, err := manager.PersistMaterialChange(ctx, first)
	if err != nil {
		t.Fatal(err)
	}
	if second.StateVersion != 2 || second.Reason != ReasonMaterialChange {
		t.Fatalf("unexpected second snapshot: %+v", second)
	}
}

func TestManagerRestoreReturnsDefensiveStateCopy(t *testing.T) {
	initial := validSnapshot("value-1", StrategyValueInvestor)
	initial.StateVersion = 4
	repository := newMemoryRepository(initial)
	manager := NewManager(repository)
	if err := manager.Restore(context.Background()); err != nil {
		t.Fatal(err)
	}
	loaded, ok := manager.Get("value-1")
	if !ok || loaded.StateVersion != 4 {
		t.Fatalf("state not restored: %+v", loaded)
	}
	loaded.State[2] = 'X'
	again, _ := manager.Get("value-1")
	if !json.Valid(again.State) {
		t.Fatal("caller mutated manager-owned state")
	}
}

func TestManagerShutdownFlushIsDeterministicAndRetainsFailures(t *testing.T) {
	repository := newMemoryRepository()
	manager := NewManager(repository)
	for _, snapshot := range []Snapshot{
		validSnapshot("value-2", StrategyValueInvestor),
		validSnapshot("bandar-1", StrategyBandar),
		validSnapshot("index-3", StrategyIndexTracker),
	} {
		if err := manager.Track(snapshot); err != nil {
			t.Fatal(err)
		}
	}
	repository.fail["index-3"] = errors.New("database unavailable")
	err := manager.Flush(context.Background())
	if err == nil {
		t.Fatal("expected flush failure")
	}
	if len(repository.saves) != 2 ||
		repository.saves[0].BotID != "bandar-1" ||
		repository.saves[1].BotID != "value-2" {
		t.Fatalf("successful saves are not deterministic: %+v", repository.saves)
	}
	delete(repository.fail, "index-3")
	if err := manager.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	if repository.saves[2].BotID != "index-3" ||
		repository.saves[2].Reason != ReasonShutdown {
		t.Fatalf("failed state was not retained for retry: %+v", repository.saves)
	}
}

func TestSnapshotValidationRejectsInvalidBoundary(t *testing.T) {
	tests := []Snapshot{
		{BotID: "x", Strategy: "noise_trader", State: json.RawMessage(`{}`), Reason: ReasonTransition},
		{BotID: "x", Strategy: StrategyBandar, State: json.RawMessage(`[]`), Reason: ReasonTransition},
		{BotID: "x", Strategy: StrategyBandar, State: json.RawMessage(`{}`), Reason: ReasonTransition,
			Checkpoint: Checkpoint{EventSequence: -1}},
	}
	for _, snapshot := range tests {
		if err := snapshot.Validate(); err == nil {
			t.Fatalf("expected invalid snapshot: %+v", snapshot)
		}
	}
}

func TestManagerRejectsStrategyTypeChange(t *testing.T) {
	manager := NewManager(newMemoryRepository())
	snapshot := validSnapshot("bot-1", StrategyBandar)
	if err := manager.Track(snapshot); err != nil {
		t.Fatal(err)
	}
	snapshot.Strategy = StrategyIndexTracker
	if err := manager.Track(snapshot); err == nil {
		t.Fatal("expected strategy type change rejection")
	}
}
