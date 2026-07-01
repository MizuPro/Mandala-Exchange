package metrics

import (
	"testing"
	"time"
)

// TestRecordQueueMetrics verifies queue depth and wait time recording.
func TestRecordQueueMetrics(t *testing.T) {
	// Reset global state for test isolation
	global = &MetricsStore{}

	RecordQueueMetrics(42, 150*time.Millisecond)

	snap := Snapshot()
	if snap.QueueDepth != 42 {
		t.Errorf("expected QueueDepth=42, got %d", snap.QueueDepth)
	}
	if snap.QueueWait != 150*time.Millisecond {
		t.Errorf("expected QueueWait=150ms, got %v", snap.QueueWait)
	}
}

// TestRecordAPILatency verifies API latency recording.
func TestRecordAPILatency(t *testing.T) {
	global = &MetricsStore{}

	RecordAPILatency(250 * time.Millisecond)

	snap := Snapshot()
	if snap.APILatency != 250*time.Millisecond {
		t.Errorf("expected APILatency=250ms, got %v", snap.APILatency)
	}
}

// TestRecordOrderRate verifies order rate recording.
func TestRecordOrderRate(t *testing.T) {
	global = &MetricsStore{}

	RecordOrderRate(300.0)

	snap := Snapshot()
	if snap.OrderRate != 300.0 {
		t.Errorf("expected OrderRate=300.0, got %f", snap.OrderRate)
	}
}

// TestIncrementReject verifies that reject count increments correctly.
func TestIncrementReject(t *testing.T) {
	global = &MetricsStore{}

	IncrementReject()
	IncrementReject()
	IncrementReject()

	snap := Snapshot()
	if snap.RejectCount != 3 {
		t.Errorf("expected RejectCount=3, got %d", snap.RejectCount)
	}
}

// TestRecordEventLag verifies event lag recording.
// EventLag represents the delay between account stream event occurred_at and consumer processing.
func TestRecordEventLag(t *testing.T) {
	global = &MetricsStore{}

	RecordEventLag(75 * time.Millisecond)

	snap := Snapshot()
	if snap.EventLag != 75*time.Millisecond {
		t.Errorf("expected EventLag=75ms, got %v", snap.EventLag)
	}
}

// TestRecordSchedulerLag verifies scheduler lag recording.
func TestRecordSchedulerLag(t *testing.T) {
	global = &MetricsStore{}

	RecordSchedulerLag(12 * time.Millisecond)

	snap := Snapshot()
	if snap.SchedulerLag != 12*time.Millisecond {
		t.Errorf("expected SchedulerLag=12ms, got %v", snap.SchedulerLag)
	}
}

// TestRecordReconciliationMismatch verifies reconciliation mismatch counter.
func TestRecordReconciliationMismatch(t *testing.T) {
	global = &MetricsStore{}

	RecordReconciliationMismatch()
	RecordReconciliationMismatch()

	snap := Snapshot()
	if snap.ReconciliationMismatch != 2 {
		t.Errorf("expected ReconciliationMismatch=2, got %d", snap.ReconciliationMismatch)
	}
}

// TestCollectRuntimeMetrics verifies that runtime metrics collection
// populates RSSBytes and Goroutines without panicking.
// CPUPercent is acknowledged to be 0.0 in MVP (OS-specific sampling not yet wired).
func TestCollectRuntimeMetrics(t *testing.T) {
	global = &MetricsStore{}

	CollectRuntimeMetrics()

	snap := Snapshot()
	if snap.RSSBytes == 0 {
		t.Error("expected RSSBytes > 0 after CollectRuntimeMetrics")
	}
	if snap.Goroutines == 0 {
		t.Error("expected Goroutines > 0 after CollectRuntimeMetrics")
	}
	// CPUPercent is 0.0 in MVP — acknowledged limitation, not a bug
	t.Logf("RSSBytes=%d, Goroutines=%d, CPUPercent=%.2f (0.0 expected in MVP)",
		snap.RSSBytes, snap.Goroutines, snap.CPUPercent)
}

// TestCollectDBPoolMetrics_NilPool verifies that CollectDBPoolMetrics
// does not panic when called with a nil pool.
func TestCollectDBPoolMetrics_NilPool(t *testing.T) {
	global = &MetricsStore{}

	// Must not panic
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("CollectDBPoolMetrics panicked with nil pool: %v", r)
		}
	}()

	CollectDBPoolMetrics(nil)

	snap := Snapshot()
	if snap.DBPoolActive != 0 || snap.DBPoolIdle != 0 {
		t.Error("expected zero pool stats when pool is nil")
	}
}

// TestSnapshotReturnsCopy verifies that Snapshot() returns a value copy (MetricsSnapshot)
// that does not share state with the global metrics store.
// Mutating one snapshot does not affect another snapshot taken afterwards.
func TestSnapshotReturnsCopy(t *testing.T) {
	global = &MetricsStore{}

	RecordEventLag(100 * time.Millisecond)

	snap1 := Snapshot()
	if snap1.EventLag != 100*time.Millisecond {
		t.Fatalf("expected EventLag=100ms in snap1, got %v", snap1.EventLag)
	}

	// Update global to a different value
	RecordEventLag(200 * time.Millisecond)

	// snap1 should still reflect 100ms (it is a value copy, not a pointer)
	snap2 := Snapshot()
	if snap2.EventLag != 200*time.Millisecond {
		t.Errorf("expected snap2.EventLag=200ms after second record, got %v", snap2.EventLag)
	}
	if snap1.EventLag != 100*time.Millisecond {
		t.Errorf("snap1 should still be 100ms (value copy), got %v", snap1.EventLag)
	}
}
