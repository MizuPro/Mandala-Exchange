package deterministic

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/Mandala-Exchange/BOT/internal/scheduler"
)

type Mode string

const (
	ModeLive              Mode = "live"
	ModeDeterministicTest Mode = "deterministic_test"
)

type Run struct {
	ID             uuid.UUID
	Mode           Mode
	GlobalSeed     int64
	BotSeeds       map[string]int64
	ConfigSnapshot json.RawMessage
	ModelVersion   string
	VirtualTime    time.Time
	Status         string
}

type Entry struct {
	Sequence      int64
	Kind          string
	EventSequence *int64
	VirtualTime   time.Time
	BotID         string
	Payload       json.RawMessage
}

type Repository interface {
	Create(context.Context, Run) error
	Append(context.Context, uuid.UUID, Entry) error
	Load(context.Context, uuid.UUID) (Run, []Entry, error)
	Complete(context.Context, uuid.UUID, time.Time) error
}

type Runtime struct {
	repository Repository
	mu         sync.Mutex
	run        Run
	next       int64
}

func New(repository Repository, run Run) (*Runtime, error) {
	if run.ID == uuid.Nil || run.ModelVersion == "" || run.VirtualTime.IsZero() {
		return nil, errors.New("run id, model version, and virtual time are required")
	}
	if run.Mode != ModeLive && run.Mode != ModeDeterministicTest {
		return nil, fmt.Errorf("invalid runtime mode %q", run.Mode)
	}
	if len(run.ConfigSnapshot) == 0 || !json.Valid(run.ConfigSnapshot) ||
		bytes.TrimSpace(run.ConfigSnapshot)[0] != '{' {
		return nil, errors.New("config snapshot must be a JSON object")
	}
	run.BotSeeds = cloneSeeds(run.BotSeeds)
	run.ConfigSnapshot = append(json.RawMessage(nil), run.ConfigSnapshot...)
	run.Status = "running"
	return &Runtime{repository: repository, run: run, next: 1}, nil
}

func (r *Runtime) Start(ctx context.Context) error {
	return r.repository.Create(ctx, r.run)
}

func (r *Runtime) Now() time.Time {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.run.VirtualTime
}

func (r *Runtime) Advance(duration time.Duration) error {
	if duration < 0 {
		return errors.New("virtual clock cannot move backwards")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.run.VirtualTime = r.run.VirtualTime.Add(duration)
	return nil
}

func (r *Runtime) Record(ctx context.Context, kind, botID string, eventSequence *int64, payload any) (Entry, error) {
	if r.run.Mode != ModeDeterministicTest {
		return Entry{}, errors.New("bit-for-bit journal is only available in deterministic_test mode")
	}
	switch kind {
	case "input", "scheduler", "decision", "order":
	default:
		return Entry{}, fmt.Errorf("invalid journal kind %q", kind)
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return Entry{}, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	entry := Entry{Sequence: r.next, Kind: kind, EventSequence: eventSequence,
		VirtualTime: r.run.VirtualTime, BotID: botID, Payload: data}
	if err := r.repository.Append(ctx, r.run.ID, entry); err != nil {
		return Entry{}, err
	}
	r.next++
	return entry, nil
}

func (r *Runtime) Complete(ctx context.Context) error {
	return r.repository.Complete(ctx, r.run.ID, r.Now())
}

// SchedulerObserver persists the exact stable order assigned by Scheduler.
// An append error is reported through onError because the scheduler callback
// cannot safely block strategy execution with a returned error.
func (r *Runtime) SchedulerObserver(ctx context.Context, onError func(error)) func(scheduler.Task) {
	return func(task scheduler.Task) {
		_, err := r.Record(ctx, "scheduler", task.BotID, nil, map[string]any{
			"scheduler_sequence": task.Sequence,
			"execute_at":         task.ExecuteAt.UTC(),
		})
		if err != nil && onError != nil {
			onError(err)
		}
	}
}

func Replay(entries []Entry, handler func(Entry) (json.RawMessage, error)) ([]json.RawMessage, error) {
	ordered := append([]Entry(nil), entries...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].Sequence < ordered[j].Sequence })
	results := make([]json.RawMessage, 0, len(ordered))
	var previous int64
	for _, entry := range ordered {
		if entry.Sequence != previous+1 {
			return nil, fmt.Errorf("journal sequence gap after %d", previous)
		}
		result, err := handler(entry)
		if err != nil {
			return nil, err
		}
		results = append(results, append(json.RawMessage(nil), result...))
		previous = entry.Sequence
	}
	return results, nil
}

func cloneSeeds(seeds map[string]int64) map[string]int64 {
	result := make(map[string]int64, len(seeds))
	for botID, seed := range seeds {
		result[botID] = seed
	}
	return result
}
