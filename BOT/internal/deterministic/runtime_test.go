package deterministic

import (
	"context"
	"encoding/json"
	"math/rand"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Mandala-Exchange/BOT/internal/scheduler"
)

type memoryRepository struct {
	run     Run
	entries []Entry
}

func (m *memoryRepository) Create(_ context.Context, run Run) error {
	m.run = run
	return nil
}
func (m *memoryRepository) Append(_ context.Context, _ uuid.UUID, entry Entry) error {
	m.entries = append(m.entries, entry)
	return nil
}
func (m *memoryRepository) Load(context.Context, uuid.UUID) (Run, []Entry, error) {
	return m.run, append([]Entry(nil), m.entries...), nil
}
func (m *memoryRepository) Complete(context.Context, uuid.UUID, time.Time) error { return nil }

func testRun() Run {
	return Run{ID: uuid.New(), Mode: ModeDeterministicTest, GlobalSeed: 77,
		BotSeeds: map[string]int64{"bot-a": 101}, ConfigSnapshot: json.RawMessage(`{"version":3}`),
		ModelVersion: "bot-v1", VirtualTime: time.Date(2026, 7, 1, 9, 0, 0, 0, time.UTC)}
}

func TestRuntimeVirtualClockJournalAndReplay(t *testing.T) {
	repository := &memoryRepository{}
	runtime, err := New(repository, testRun())
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := runtime.Start(ctx); err != nil {
		t.Fatal(err)
	}
	eventSequence := int64(15)
	if _, err := runtime.Record(ctx, "input", "", &eventSequence, map[string]any{"price": 1000}); err != nil {
		t.Fatal(err)
	}
	if err := runtime.Advance(30 * time.Second); err != nil {
		t.Fatal(err)
	}
	if _, err := runtime.Record(ctx, "scheduler", "bot-a", nil, map[string]any{"task": "evaluate"}); err != nil {
		t.Fatal(err)
	}
	runtime.SchedulerObserver(ctx, func(err error) { t.Fatal(err) })(scheduler.Task{
		BotID: "bot-a", Sequence: 2, ExecuteAt: runtime.Now(),
	})
	if _, err := runtime.Record(ctx, "order", "bot-a", nil, map[string]any{"side": "buy"}); err != nil {
		t.Fatal(err)
	}
	handler := func(entry Entry) (json.RawMessage, error) {
		random := rand.New(rand.NewSource(repository.run.BotSeeds["bot-a"] + entry.Sequence))
		return json.Marshal([]any{entry.Kind, entry.BotID, random.Int63n(1000)})
	}
	first, err := Replay(repository.entries, handler)
	if err != nil {
		t.Fatal(err)
	}
	second, err := Replay(repository.entries, handler)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("replay diverged: %s != %s", first, second)
	}
	if runtime.Now() != testRun().VirtualTime.Add(30*time.Second) {
		t.Fatal("virtual clock did not advance deterministically")
	}
}

func TestRuntimeRejectsLiveJournalAndSequenceGap(t *testing.T) {
	run := testRun()
	run.Mode = ModeLive
	runtime, err := New(&memoryRepository{}, run)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := runtime.Record(context.Background(), "input", "", nil, struct{}{}); err == nil {
		t.Fatal("live mode must not claim bit-for-bit journal replay")
	}
	_, err = Replay([]Entry{{Sequence: 2}}, func(Entry) (json.RawMessage, error) { return nil, nil })
	if err == nil {
		t.Fatal("expected sequence gap")
	}
	if err := runtime.Advance(-time.Second); err == nil {
		t.Fatal("virtual clock moved backwards")
	}
}

func TestPostgresRunArtifactSurvivesRestart(t *testing.T) {
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
	repository := NewPostgresRepository(pool)
	run := testRun()
	runtime, err := New(repository, run)
	if err != nil {
		t.Fatal(err)
	}
	if err := runtime.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM simulation_runs WHERE run_id=$1`, run.ID) })
	sequence := int64(9)
	if _, err := runtime.Record(ctx, "input", "", &sequence, map[string]int{"price": 1200}); err != nil {
		t.Fatal(err)
	}
	if _, err := runtime.Record(ctx, "scheduler", "bot-a", nil, map[string]string{"task": "evaluate"}); err != nil {
		t.Fatal(err)
	}
	if err := runtime.Complete(ctx); err != nil {
		t.Fatal(err)
	}
	loaded, entries, err := repository.Load(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Status != "completed" || loaded.GlobalSeed != run.GlobalSeed ||
		loaded.BotSeeds["bot-a"] != 101 || len(entries) != 2 ||
		entries[0].EventSequence == nil || *entries[0].EventSequence != 9 {
		t.Fatalf("incomplete run artifact after restart: run=%+v entries=%+v", loaded, entries)
	}
}
