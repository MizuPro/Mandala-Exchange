package metrics

import (
	"runtime"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// MetricsStore holds all operational metrics for the BOT service.
// All fields are updated via thread-safe methods.
//
// Metrics collected per BOT_MAIN_PLAN.md Task 1.8:
//   - CPU/RSS, goroutine count
//   - Queue depth / wait time
//   - API latency, order rate, reject count
//   - Event lag (account stream consumer behind live)
//   - Reconciliation mismatch count
//   - Scheduler lag
//   - DB pool (active / idle connections)
type MetricsStore struct {
	mu sync.RWMutex

	// Runtime
	CPUPercent float64 // Approximate CPU usage (populated from OS-specific sampling; simplified for MVP)
	RSSBytes   uint64  // Resident set size in bytes (from runtime.MemStats.Sys)
	Goroutines int     // Current goroutine count

	// Queue
	QueueDepth int           // Current number of items in the order queue
	QueueWait  time.Duration // Estimated wait time for the next item in queue

	// API
	APILatency  time.Duration // Last observed Sekuritas API round-trip latency
	OrderRate   float64       // Orders submitted per minute (rolling)
	RejectCount int64         // Total orders rejected since startup

	// Event / Scheduler
	EventLag     time.Duration // Lag between account stream event occurred_at and consumer processing time
	SchedulerLag time.Duration // Lag between scheduled ExecuteAt and actual execution time

	// Reconciliation
	ReconciliationMismatch int64 // Count of accounts with mismatched state since startup

	// DB pool
	DBPoolActive int // Current number of active (in-use) DB connections
	DBPoolIdle   int // Current number of idle DB connections
}

// global is the process-level metrics singleton.
var global = &MetricsStore{}

// ── Queue Metrics ─────────────────────────────────────────────────────────────

// RecordQueueMetrics updates the queue depth and estimated wait time.
func RecordQueueMetrics(depth int, wait time.Duration) {
	global.mu.Lock()
	defer global.mu.Unlock()
	global.QueueDepth = depth
	global.QueueWait = wait
}

// ── API Metrics ───────────────────────────────────────────────────────────────

// RecordAPILatency records the round-trip latency for a Sekuritas API call.
func RecordAPILatency(latency time.Duration) {
	global.mu.Lock()
	defer global.mu.Unlock()
	global.APILatency = latency
}

// RecordOrderRate updates the rolling order submission rate (orders per minute).
func RecordOrderRate(ratePerMinute float64) {
	global.mu.Lock()
	defer global.mu.Unlock()
	global.OrderRate = ratePerMinute
}

// IncrementReject increments the total rejected order count.
func IncrementReject() {
	global.mu.Lock()
	defer global.mu.Unlock()
	global.RejectCount++
}

// ── Event / Scheduler Metrics ─────────────────────────────────────────────────

// RecordEventLag records the lag between when an account stream event occurred
// and when the BOT consumer processed it. This measures consumer pipeline delay.
// A large EventLag indicates the consumer is falling behind the live stream.
func RecordEventLag(lag time.Duration) {
	global.mu.Lock()
	defer global.mu.Unlock()
	global.EventLag = lag
}

// RecordSchedulerLag records the difference between a task's scheduled ExecuteAt
// and when the worker actually began executing it.
func RecordSchedulerLag(lag time.Duration) {
	global.mu.Lock()
	defer global.mu.Unlock()
	global.SchedulerLag = lag
}

// ── Reconciliation Metrics ────────────────────────────────────────────────────

// RecordReconciliationMismatch increments the mismatch counter.
// Called when a bot's local portfolio state does not match the Sekuritas snapshot.
func RecordReconciliationMismatch() {
	global.mu.Lock()
	defer global.mu.Unlock()
	global.ReconciliationMismatch++
}

// ── Runtime Metrics ───────────────────────────────────────────────────────────

// CollectRuntimeMetrics refreshes CPU, RSS, and goroutine metrics.
// CPU percentage requires OS-specific sampling (e.g. /proc/stat on Linux or
// pdh on Windows) and is left at 0.0 until a platform-specific collector is
// wired in. RSS is approximated via runtime.MemStats.Sys.
func CollectRuntimeMetrics() {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)

	global.mu.Lock()
	defer global.mu.Unlock()
	global.RSSBytes = m.Sys
	global.Goroutines = runtime.NumGoroutine()
	// CPUPercent: requires sampling /proc/stat (Linux) or PDH (Windows).
	// Left at 0.0 for MVP; a platform collector will update this field.
}

// ── DB Pool Metrics ───────────────────────────────────────────────────────────

// CollectDBPoolMetrics refreshes DB pool active/idle connection counts
// from the provided pgxpool.Pool. Should be called periodically (e.g. every 5s).
func CollectDBPoolMetrics(pool *pgxpool.Pool) {
	if pool == nil {
		return
	}
	stat := pool.Stat()
	global.mu.Lock()
	defer global.mu.Unlock()
	global.DBPoolActive = int(stat.AcquiredConns())
	global.DBPoolIdle = int(stat.IdleConns())
}

// ── Snapshot ──────────────────────────────────────────────────────────────────

// MetricsSnapshot is a lock-free copy of all metrics fields.
// Use this instead of MetricsStore when you need a point-in-time read.
type MetricsSnapshot struct {
	CPUPercent             float64
	RSSBytes               uint64
	Goroutines             int
	QueueDepth             int
	QueueWait              time.Duration
	APILatency             time.Duration
	OrderRate              float64
	RejectCount            int64
	EventLag               time.Duration
	SchedulerLag           time.Duration
	ReconciliationMismatch int64
	DBPoolActive           int
	DBPoolIdle             int
}

// Snapshot returns a point-in-time copy of all metrics fields.
// The returned MetricsSnapshot contains no mutex and is safe to read freely.
func Snapshot() MetricsSnapshot {
	global.mu.RLock()
	defer global.mu.RUnlock()
	return MetricsSnapshot{
		CPUPercent:             global.CPUPercent,
		RSSBytes:               global.RSSBytes,
		Goroutines:             global.Goroutines,
		QueueDepth:             global.QueueDepth,
		QueueWait:              global.QueueWait,
		APILatency:             global.APILatency,
		OrderRate:              global.OrderRate,
		RejectCount:            global.RejectCount,
		EventLag:               global.EventLag,
		SchedulerLag:           global.SchedulerLag,
		ReconciliationMismatch: global.ReconciliationMismatch,
		DBPoolActive:           global.DBPoolActive,
		DBPoolIdle:             global.DBPoolIdle,
	}
}
