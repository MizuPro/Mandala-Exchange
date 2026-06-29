package scheduler

import (
	"container/heap"
	"context"
	"fmt"
	"hash/fnv"
	"sync"
	"time"
)

type Task struct {
	BotID     string
	ExecuteAt time.Time
	Payload   interface{}
	Handler   func(ctx context.Context, botID string, payload interface{}) error
}

type TaskQueue []*Task

func (pq TaskQueue) Len() int { return len(pq) }
func (pq TaskQueue) Less(i, j int) bool {
	return pq[i].ExecuteAt.Before(pq[j].ExecuteAt)
}
func (pq TaskQueue) Swap(i, j int) {
	pq[i], pq[j] = pq[j], pq[i]
}
func (pq *TaskQueue) Push(x interface{}) {
	*pq = append(*pq, x.(*Task))
}
func (pq *TaskQueue) Pop() interface{} {
	old := *pq
	n := len(old)
	item := old[n-1]
	*pq = old[0 : n-1]
	return item
}

type MarketSnapshot struct {
	Symbol     string
	Price      int64
	LastUpdate time.Time
}

type Scheduler struct {
	mu        sync.Mutex
	queue     TaskQueue
	snapshots map[string]MarketSnapshot
	workers   int
}

func NewScheduler(workers int) *Scheduler {
	return &Scheduler{
		queue:     make(TaskQueue, 0),
		snapshots: make(map[string]MarketSnapshot),
		workers:   workers,
	}
}

func (s *Scheduler) Schedule(task *Task) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Stable jitter prevents synchronized wakeups while preserving replay ordering.
	hasher := fnv.New32a()
	_, _ = hasher.Write([]byte(task.BotID))
	jitter := time.Duration(hasher.Sum32()%100) * time.Millisecond
	task.ExecuteAt = task.ExecuteAt.Add(jitter)

	heap.Push(&s.queue, task)
}

func (s *Scheduler) UpdateSnapshot(snapshot MarketSnapshot) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.snapshots[snapshot.Symbol] = snapshot
}

func (s *Scheduler) GetSnapshot(symbol string) (MarketSnapshot, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	snap, ok := s.snapshots[symbol]
	return snap, ok
}

func (s *Scheduler) Run(ctx context.Context) {
	taskCh := make(chan *Task, 1000)

	// Start workers
	for i := 0; i < s.workers; i++ {
		go s.worker(ctx, taskCh)
	}

	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.dispatch(taskCh)
		}
	}
}

func (s *Scheduler) dispatch(taskCh chan<- *Task) {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now()
	for s.queue.Len() > 0 {
		if s.queue[0].ExecuteAt.After(now) {
			break
		}
		task := heap.Pop(&s.queue).(*Task)
		taskCh <- task
	}
}

func (s *Scheduler) worker(ctx context.Context, taskCh <-chan *Task) {
	for {
		select {
		case <-ctx.Done():
			return
		case task := <-taskCh:
			s.executeTask(ctx, task)
		}
	}
}

func (s *Scheduler) executeTask(ctx context.Context, task *Task) {
	defer func() {
		if r := recover(); r != nil {
			// Panic isolation per task
			fmt.Printf("Recovered from panic in task for bot %s: %v\n", task.BotID, r)
		}
	}()

	err := task.Handler(ctx, task.BotID, task.Payload)
	if err != nil {
		fmt.Printf("Error executing task for bot %s: %v\n", task.BotID, err)
	}
}
