package session

import (
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestRolloverAndVirtualClock(t *testing.T) {
	monitor := NewMonitor()
	first := SessionInstance{InstanceID: uuid.New(), VirtualDayIndex: 1, VirtualDurationSecs: 21600, RealDurationSecs: 1800}
	second := SessionInstance{InstanceID: uuid.New(), VirtualDayIndex: 2, VirtualDurationSecs: 21600, RealDurationSecs: 1800}
	rollovers := 0
	monitor.OnRollover(func(previous, current SessionInstance) { rollovers++ })
	monitor.UpdateInstance(&first)
	monitor.UpdateInstance(&first)
	monitor.UpdateInstance(&second)
	if rollovers != 1 {
		t.Fatalf("expected exactly one rollover, got %d", rollovers)
	}
	if delay := monitor.VirtualToRealDelay(12 * time.Minute); delay != time.Minute {
		t.Fatalf("unexpected compressed delay %s", delay)
	}
}

// TestMonotonicityGuard verifies that a regressed VirtualDayIndex is silently dropped.
func TestMonotonicityGuard(t *testing.T) {
	monitor := NewMonitor()
	rollovers := 0
	monitor.OnRollover(func(_, _ SessionInstance) { rollovers++ })

	first := &SessionInstance{InstanceID: uuid.New(), VirtualDayIndex: 5, VirtualDurationSecs: 21600, RealDurationSecs: 1800}
	monitor.UpdateInstance(first)

	// Regressed VirtualDayIndex must be silently ignored
	regressed := &SessionInstance{InstanceID: uuid.New(), VirtualDayIndex: 3, VirtualDurationSecs: 21600, RealDurationSecs: 1800}
	monitor.UpdateInstance(regressed)
	if rollovers != 0 {
		t.Fatal("rollover must not fire for regressed VirtualDayIndex")
	}
	inst := monitor.GetInstance()
	if inst == nil || inst.VirtualDayIndex != 5 {
		t.Fatalf("expected day_index=5 after regressed update, got %v", inst)
	}
}

// TestInvalidInstanceIgnored verifies that nil, zero-UUID, or zero-duration instances are dropped.
func TestInvalidInstanceIgnored(t *testing.T) {
	monitor := NewMonitor()
	monitor.UpdateInstance(nil)
	if monitor.GetInstance() != nil {
		t.Fatal("nil instance must be ignored")
	}
	monitor.UpdateInstance(&SessionInstance{}) // zero UUID
	if monitor.GetInstance() != nil {
		t.Fatal("zero-UUID instance must be ignored")
	}
	monitor.UpdateInstance(&SessionInstance{InstanceID: uuid.New(), VirtualDurationSecs: 0, RealDurationSecs: 1800})
	if monitor.GetInstance() != nil {
		t.Fatal("zero VirtualDurationSecs instance must be ignored")
	}
	monitor.UpdateInstance(&SessionInstance{InstanceID: uuid.New(), VirtualDurationSecs: 21600, RealDurationSecs: 0})
	if monitor.GetInstance() != nil {
		t.Fatal("zero RealDurationSecs instance must be ignored")
	}
}

// TestIsActiveAndNonCancellation verifies state-based readiness.
func TestIsActiveAndNonCancellation(t *testing.T) {
	monitor := NewMonitor()

	cases := []struct {
		status       SessionState
		expectActive bool
		expectNCP    bool
	}{
		{StateContinuous, true, false},
		{StateOpeningAuction, true, false},
		{StateClosingAuction, true, false},
		{StateNonCancellation, false, true},
		{StatePreOpen, false, false},
		{StateClosed, false, false},
		{StateFinalized, false, false},
	}

	// Each case gets an independently incrementing VirtualDayIndex so the
	// monotonicity guard never drops any test instance.
	for i, tc := range cases {
		inst := &SessionInstance{
			InstanceID:          uuid.New(),
			VirtualDayIndex:     100 + i, // always higher than previous
			VirtualDurationSecs: 21600,
			RealDurationSecs:    1800,
			Status:              tc.status,
		}
		monitor.UpdateInstance(inst)
		if got := monitor.IsActive(); got != tc.expectActive {
			t.Errorf("status=%s: IsActive()=%v, want %v", tc.status, got, tc.expectActive)
		}
		if got := monitor.IsNonCancellation(); got != tc.expectNCP {
			t.Errorf("status=%s: IsNonCancellation()=%v, want %v", tc.status, got, tc.expectNCP)
		}
	}
}

// TestVirtualToRealDelayFallback verifies 1:1 fallback when no session is loaded.
func TestVirtualToRealDelayFallback(t *testing.T) {
	monitor := NewMonitor()
	d := 5 * time.Minute
	if got := monitor.VirtualToRealDelay(d); got != d {
		t.Fatalf("expected 1:1 fallback when no session, got %s", got)
	}
}

// TestRealTimeRemaining verifies RealTimeRemaining uses RealTimeRemainSecs.
func TestRealTimeRemaining(t *testing.T) {
	monitor := NewMonitor()
	if monitor.RealTimeRemaining() != 0 {
		t.Fatal("no session: RealTimeRemaining should be 0")
	}
	inst := &SessionInstance{
		InstanceID:          uuid.New(),
		VirtualDayIndex:     1,
		VirtualDurationSecs: 21600,
		RealDurationSecs:    1800,
		RealTimeRemainSecs:  600,
	}
	monitor.UpdateInstance(inst)
	if monitor.RealTimeRemaining() != 600*time.Second {
		t.Fatalf("expected 600s remaining, got %s", monitor.RealTimeRemaining())
	}
}

func TestSessionProgressAtBoundaries(t *testing.T) {
	monitor := NewMonitor()
	start := time.Date(2026, 7, 1, 9, 0, 0, 0, time.UTC)
	monitor.UpdateInstance(&SessionInstance{
		InstanceID: uuid.New(), VirtualDayIndex: 1,
		VirtualDurationSecs: 21600, RealDurationSecs: 100,
		StartedAt: start,
	})
	if got := monitor.SessionProgressAt(start.Add(30 * time.Second)); got != .30 {
		t.Fatalf("progress = %v, want .30", got)
	}
	if got := monitor.SessionProgressAt(start.Add(-time.Second)); got != 0 {
		t.Fatalf("pre-start progress = %v", got)
	}
	if got := monitor.SessionProgressAt(start.Add(101 * time.Second)); got != 1 {
		t.Fatalf("post-end progress = %v", got)
	}
}
