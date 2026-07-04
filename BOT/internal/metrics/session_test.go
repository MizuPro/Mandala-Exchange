package metrics

import "testing"

func TestManagerResetsPerSessionAndTracksStrategy(t *testing.T) {
	manager := NewManager()
	manager.RecordRunner("session-1", "noise_trader", 1, 1, 1, 0)
	manager.RecordEvent("session-1", "noise_trader", "order_accepted")
	manager.RecordEvent("session-1", "noise_trader", "order_filled")

	first := manager.Snapshot()
	if first.Total.Decisions != 1 || first.Total.Filled != 1 {
		t.Fatalf("unexpected first session metrics: %#v", first.Total)
	}

	manager.RecordRunner("session-2", "noise_trader", 1, 0, 0, 0)
	second := manager.Snapshot()
	if second.SessionID != "session-2" || second.Total.Decisions != 0 || second.Total.Filled != 0 {
		t.Fatalf("metrics were not reset: %#v", second)
	}
}

func TestManagerTracksNewMetricsFase4F(t *testing.T) {
	manager := NewManager()
	sessionID := "session-test"

	// Record Actions
	manager.RecordAction(sessionID, "noise_trader", "place")
	manager.RecordAction(sessionID, "noise_trader", "cancel")
	manager.RecordAction(sessionID, "noise_trader", "amend")

	// Record Latency & Queue Depth
	manager.RecordLatency(sessionID, "noise_trader", 150)
	manager.RecordLatency(sessionID, "noise_trader", 250)
	manager.RecordQueueDepth(sessionID, 5)

	// Record Reject Reason
	manager.RecordRejectReason(sessionID, "noise_trader", "insufficient_cash")
	manager.RecordRejectReason(sessionID, "noise_trader", "insufficient_cash")

	snap := manager.Snapshot()

	if snap.Total.PlaceCount != 1 || snap.Total.CancelCount != 1 || snap.Total.AmendCount != 1 {
		t.Errorf("expected place/cancel/amend count = 1, got place=%d, cancel=%d, amend=%d",
			snap.Total.PlaceCount, snap.Total.CancelCount, snap.Total.AmendCount)
	}

	if snap.Total.LatencyTotalMs != 400 || snap.Total.LatencyCount != 2 {
		t.Errorf("unexpected latency totals: total=%d, count=%d", snap.Total.LatencyTotalMs, snap.Total.LatencyCount)
	}

	if snap.Total.QueueDepth != 5 {
		t.Errorf("expected queue depth 5, got %d", snap.Total.QueueDepth)
	}

	if snap.RejectReasons["insufficient_cash"] != 2 {
		t.Errorf("expected reject reason 'insufficient_cash' frequency 2, got %d", snap.RejectReasons["insufficient_cash"])
	}
}

