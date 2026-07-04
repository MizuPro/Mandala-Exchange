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
