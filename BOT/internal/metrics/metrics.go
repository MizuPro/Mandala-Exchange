package metrics

import (
	"runtime"
	"sync"
	"time"
)

type MetricsStore struct {
	mu sync.RWMutex

	// Runtime
	CPUPercent float64
	RSSBytes   uint64
	Goroutines int

	// Queue
	QueueDepth int
	QueueWait  time.Duration

	// API
	APILatency  time.Duration
	OrderRate   float64 // orders per minute
	RejectCount int64

	// Event/Scheduler
	EventLag     time.Duration
	SchedulerLag time.Duration

	// Reconciliation
	ReconciliationMismatch int64

	// DB
	DBPoolActive int
	DBPoolIdle   int
}

var globalMetrics = &MetricsStore{}

func RecordQueueMetrics(depth int, wait time.Duration) {
	globalMetrics.mu.Lock()
	defer globalMetrics.mu.Unlock()
	globalMetrics.QueueDepth = depth
	globalMetrics.QueueWait = wait
}

func RecordAPILatency(latency time.Duration) {
	globalMetrics.mu.Lock()
	defer globalMetrics.mu.Unlock()
	globalMetrics.APILatency = latency
}

func RecordOrderRate(rate float64) {
	globalMetrics.mu.Lock()
	defer globalMetrics.mu.Unlock()
	globalMetrics.OrderRate = rate
}

func IncrementReject() {
	globalMetrics.mu.Lock()
	defer globalMetrics.mu.Unlock()
	globalMetrics.RejectCount++
}

func RecordSchedulerLag(lag time.Duration) {
	globalMetrics.mu.Lock()
	defer globalMetrics.mu.Unlock()
	globalMetrics.SchedulerLag = lag
}

func RecordReconciliationMismatch() {
	globalMetrics.mu.Lock()
	defer globalMetrics.mu.Unlock()
	globalMetrics.ReconciliationMismatch++
}

func CollectRuntimeMetrics() {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)

	globalMetrics.mu.Lock()
	defer globalMetrics.mu.Unlock()
	globalMetrics.RSSBytes = m.Sys
	globalMetrics.Goroutines = runtime.NumGoroutine()
	// CPU percentage requires sampling /proc/stat or OS specific methods, simplified for MVP
}
