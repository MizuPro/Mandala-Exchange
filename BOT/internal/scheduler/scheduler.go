package scheduler

import (
	"container/heap"
	"context"
	"fmt"
	"hash/fnv"
	"sync"
	"time"
)

// ── Task ─────────────────────────────────────────────────────────────────────

// Task represents a single scheduled action for one bot.
type Task struct {
	BotID     string
	ExecuteAt time.Time
	Sequence  uint64
	Payload   interface{}
	Handler   func(ctx context.Context, botID string, payload interface{}) error
}

type taskHeap []*Task

func (pq taskHeap) Len() int { return len(pq) }
func (pq taskHeap) Less(i, j int) bool {
	if pq[i].ExecuteAt.Equal(pq[j].ExecuteAt) {
		return pq[i].Sequence < pq[j].Sequence
	}
	return pq[i].ExecuteAt.Before(pq[j].ExecuteAt)
}
func (pq taskHeap) Swap(i, j int) { pq[i], pq[j] = pq[j], pq[i] }
func (pq *taskHeap) Push(x interface{}) {
	*pq = append(*pq, x.(*Task))
}
func (pq *taskHeap) Pop() interface{} {
	old := *pq
	n := len(old)
	item := old[n-1]
	*pq = old[0 : n-1]
	return item
}

// ── MarketSnapshot ────────────────────────────────────────────────────────────

// MarketSnapshot is an immutable snapshot of market state for one symbol.
// All fields are read-only once published. To update, publish a new value.
// This ensures bots never observe a partially-updated state.
type MarketSnapshot struct {
	Symbol       string
	Price        int64
	LotSize      int64
	RulesVersion string
	LastUpdate   time.Time
}

// ── SnapshotStore ─────────────────────────────────────────────────────────────

// SnapshotStore holds the latest immutable snapshot per symbol.
// Reads return a value copy — the caller cannot mutate the stored snapshot.
// Writes atomically replace the entire snapshot for a symbol.
type SnapshotStore struct {
	mu        sync.RWMutex
	snapshots map[string]MarketSnapshot
}

// NewSnapshotStore creates a new SnapshotStore.
func NewSnapshotStore() *SnapshotStore {
	return &SnapshotStore{snapshots: make(map[string]MarketSnapshot)}
}

// Publish atomically replaces the snapshot for a symbol.
func (s *SnapshotStore) Publish(snap MarketSnapshot) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.snapshots[snap.Symbol] = snap // value copy stored
}

// Get returns a copy of the snapshot for the given symbol, and whether it exists.
// Returning a value copy ensures callers cannot mutate the shared snapshot.
func (s *SnapshotStore) Get(symbol string) (MarketSnapshot, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	snap, ok := s.snapshots[symbol]
	return snap, ok // value copy returned
}

func (s *SnapshotStore) LastPriceIDR(symbol string) (int64, bool) {
	snapshot, ok := s.Get(symbol)
	return snapshot.Price, ok && snapshot.Price > 0
}

func (s *SnapshotStore) LotSize(symbol string) (int64, bool) {
	snapshot, ok := s.Get(symbol)
	return snapshot.LotSize, ok && snapshot.LotSize > 0
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

// Scheduler dispatches scheduled tasks to a bounded worker pool.
// It uses a min-heap sorted by ExecuteAt, and applies deterministic per-bot
// jitter based on bot ID hash to prevent synchronized wakeup bursts.
//
// Design:
//   - taskCh is bounded (capacity = workerCount * 50) to apply backpressure.
//   - dispatch() sends to taskCh non-blocking; if full, the task is re-queued
//     for the next tick (50ms), providing natural backpressure.
//   - Workers run in goroutines with panic isolation per task.
type Scheduler struct {
	mu        sync.Mutex
	queue     taskHeap
	Snapshots *SnapshotStore
	workers   int
	nextOrder uint64
	onOrder   func(Task)
}

// NewScheduler creates a Scheduler with the given number of worker goroutines.
// Per PRD: 4–8 strategy workers are required.
func NewScheduler(workers int) *Scheduler {
	if workers < 1 {
		workers = 4
	}
	return &Scheduler{
		queue:     make(taskHeap, 0),
		Snapshots: NewSnapshotStore(),
		workers:   workers,
	}
}

// Schedule enqueues a task with a deterministic per-bot jitter.
// The jitter is computed from the bot's ID hash — this is stable across runs
// and prevents synchronized wakeups without breaking deterministic test ordering.
func (s *Scheduler) Schedule(task *Task) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Stable jitter prevents synchronized wakeups while preserving replay ordering.
	hasher := fnv.New32a()
	_, _ = hasher.Write([]byte(task.BotID))
	jitter := time.Duration(hasher.Sum32()%100) * time.Millisecond
	task.ExecuteAt = task.ExecuteAt.Add(jitter)
	s.nextOrder++
	task.Sequence = s.nextOrder

	heap.Push(&s.queue, task)
}

// SetOrderingObserver registers a deterministic-test journal hook. The hook is
// called with a value copy after a task obtains its stable scheduler sequence.
func (s *Scheduler) SetOrderingObserver(observer func(Task)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.onOrder = observer
}

// Run starts the scheduler loop and workers. It blocks until ctx is cancelled.
func (s *Scheduler) Run(ctx context.Context) {
	// Bounded task channel: prevents dispatch goroutine from outpacing workers.
	// Capacity = workers * 50 provides bursting room without unbounded memory growth.
	taskCh := make(chan *Task, s.workers*50)

	var wg sync.WaitGroup
	// Start workers
	for i := 0; i < s.workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s.worker(ctx, taskCh)
		}()
	}

	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			// Wait for workers to cleanly exit their current select loop
			wg.Wait()
			close(taskCh)

			// Graceful Drain: log dropped tasks in channel
			for task := range taskCh {
				fmt.Printf("Scheduler shutdown: cancelled pending task %d for bot %s\n", task.Sequence, task.BotID)
			}

			// Graceful Drain: log dropped tasks in heap
			s.mu.Lock()
			for s.queue.Len() > 0 {
				task := heap.Pop(&s.queue).(*Task)
				fmt.Printf("Scheduler shutdown: cancelled scheduled task %d for bot %s\n", task.Sequence, task.BotID)
			}
			s.mu.Unlock()
			return
		case <-ticker.C:
			s.dispatch(taskCh)
		}
	}
}

// dispatch sends due tasks to the worker channel.
// If the channel is full (backpressure), tasks are left in the queue and
// retried on the next tick — they are NOT dropped or blocked on.
func (s *Scheduler) dispatch(taskCh chan<- *Task) {
	s.mu.Lock()
	var observed []Task
	now := time.Now()
	for s.queue.Len() > 0 {
		if s.queue[0].ExecuteAt.After(now) {
			break
		}
		// Non-blocking send: if channel is full, stop dispatching this tick.
		// The task stays at the top of the heap and will be retried next tick.
		task := s.queue[0]
		select {
		case taskCh <- task:
			heap.Pop(&s.queue)
			if s.onOrder != nil {
				observed = append(observed, *task)
			}
		default:
			// Backpressure: channel full, retry next tick
			observer := s.onOrder
			s.mu.Unlock()
			for _, item := range observed {
				observer(item)
			}
			return
		}
	}
	observer := s.onOrder
	s.mu.Unlock()
	for _, item := range observed {
		observer(item)
	}
}

// worker runs tasks from the task channel. Each task is executed with panic isolation.
func (s *Scheduler) worker(ctx context.Context, taskCh <-chan *Task) {
	for {
		select {
		case <-ctx.Done():
			return
		case task, ok := <-taskCh:
			if !ok {
				return
			}
			s.executeTask(ctx, task)
		}
	}
}

func (s *Scheduler) executeTask(ctx context.Context, task *Task) {
	defer func() {
		if r := recover(); r != nil {
			// Panic isolation per task — one crashing task does not kill the worker.
			fmt.Printf("Recovered from panic in task for bot %s: %v\n", task.BotID, r)
		}
	}()

	err := task.Handler(ctx, task.BotID, task.Payload)
	if err != nil {
		fmt.Printf("Error executing task for bot %s: %v\n", task.BotID, err)
	}
}
