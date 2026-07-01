package circuitbreaker

import (
	"testing"
	"time"
)

// ── Reject Surge Tests ────────────────────────────────────────────────────────

func TestBreakerRejectSurge(t *testing.T) {
	b := NewBreakerManager()
	b.SetState(StateReady) // must be ready for trip to happen

	for i := 0; i < 100; i++ {
		b.RecordReject()
	}

	if b.GetState() != StateReady {
		t.Errorf("Expected state to remain ready after exactly 100 rejects, got %s", b.GetState())
	}

	// 101st reject should trip to degraded
	b.RecordReject()

	if b.GetState() != StateDegraded {
		t.Errorf("Expected state to be degraded after 101 rejects, got %s", b.GetState())
	}
}

func TestBreakerRejectSurge_OnlyTripsFromReady(t *testing.T) {
	b := NewBreakerManager()
	// State is starting — reject surge should NOT trip it to degraded
	for i := 0; i <= 101; i++ {
		b.RecordReject()
	}
	if b.GetState() != StateStarting {
		t.Errorf("Reject surge should not trip from starting state, got %s", b.GetState())
	}
}

// ── Kill Switch Tests ─────────────────────────────────────────────────────────

func TestBreakerKillSwitch(t *testing.T) {
	b := NewBreakerManager()
	b.ActivateKillSwitch()

	if !b.IsKillSwitchActive() {
		t.Error("Expected kill switch to be active")
	}
	if b.GetState() != StateHalted {
		t.Errorf("Expected state to be halted, got %s", b.GetState())
	}
}

func TestBreakerKillSwitch_BlocksSetState(t *testing.T) {
	b := NewBreakerManager()
	b.ActivateKillSwitch()

	// SetState should be a no-op while kill switch is active
	b.SetState(StateReady)
	if b.GetState() != StateHalted {
		t.Errorf("SetState should not override halted (kill switch active), got %s", b.GetState())
	}
}

// ── Recovery Path Tests ───────────────────────────────────────────────────────

func TestBreakerKillSwitch_Recovery(t *testing.T) {
	b := NewBreakerManager()
	b.ActivateKillSwitch()

	if b.GetState() != StateHalted {
		t.Fatalf("Expected halted after kill switch, got %s", b.GetState())
	}

	// Admin-only recovery: ResetKillSwitch
	b.ResetKillSwitch()

	if b.IsKillSwitchActive() {
		t.Error("Kill switch should be inactive after reset")
	}
	if b.GetState() != StateStarting {
		t.Errorf("Expected state to be starting after reset, got %s", b.GetState())
	}

	// Now SetState should work normally
	b.SetState(StateSyncing)
	if b.GetState() != StateSyncing {
		t.Errorf("Expected syncing after reset and SetState, got %s", b.GetState())
	}
}

func TestBreakerClearDegraded(t *testing.T) {
	b := NewBreakerManager()
	b.SetState(StateDegraded)

	b.ClearDegraded()
	if b.GetState() != StateSyncing {
		t.Errorf("Expected syncing after ClearDegraded from degraded, got %s", b.GetState())
	}
}

func TestBreakerClearDegraded_NoopWhenNotDegraded(t *testing.T) {
	b := NewBreakerManager()
	b.SetState(StateReady)

	b.ClearDegraded()
	if b.GetState() != StateReady {
		t.Errorf("ClearDegraded from ready should be a no-op, got %s", b.GetState())
	}
}

// ── Queue Pressure Tests ──────────────────────────────────────────────────────

func TestBreakerQueuePressure_TripsAtThreshold(t *testing.T) {
	b := NewBreakerManager()
	b.SetState(StateReady)

	// 79% — should not trip
	b.RecordQueuePressure(79, 100)
	if b.GetState() != StateReady {
		t.Errorf("79%% queue fill should not trip breaker, got %s", b.GetState())
	}

	// 80% — should trip to degraded
	b.RecordQueuePressure(80, 100)
	if b.GetState() != StateDegraded {
		t.Errorf("80%% queue fill should trip to degraded, got %s", b.GetState())
	}
}

func TestBreakerQueuePressure_RecoveryWhenDrained(t *testing.T) {
	b := NewBreakerManager()
	b.SetState(StateReady)

	b.RecordQueuePressure(80, 100) // trip
	if b.GetState() != StateDegraded {
		t.Fatalf("Expected degraded after queue pressure trip, got %s", b.GetState())
	}

	// Queue drains below threshold
	b.ClearQueuePressure(10, 100) // 10% — below threshold
	if b.GetState() != StateSyncing {
		t.Errorf("Expected syncing after queue pressure cleared, got %s", b.GetState())
	}
}

func TestBreakerQueuePressure_NoopWhenKillSwitch(t *testing.T) {
	b := NewBreakerManager()
	b.SetState(StateReady)
	b.ActivateKillSwitch()

	b.RecordQueuePressure(100, 100)
	if b.GetState() != StateHalted {
		t.Errorf("Queue pressure should not override halted, got %s", b.GetState())
	}
}

// ── Dependency Stale Tests ────────────────────────────────────────────────────

func TestBreakerDependencyStale_TripsFromReady(t *testing.T) {
	b := NewBreakerManager()
	b.SetState(StateReady)

	b.MarkDependencyStale("bei")
	if b.GetState() != StateDegraded {
		t.Errorf("Stale BEI dependency should trip to degraded, got %s", b.GetState())
	}
	if !b.HasStaleDependency("bei") {
		t.Error("Expected bei to be stale")
	}
	if !b.AnyStaleDependency() {
		t.Error("Expected any stale dependency to be true")
	}
}

func TestBreakerDependencyStale_RecoveryWhenAllFresh(t *testing.T) {
	b := NewBreakerManager()
	b.SetState(StateReady)

	b.MarkDependencyStale("bei")
	b.MarkDependencyStale("mats_ws")

	if b.GetState() != StateDegraded {
		t.Fatalf("Expected degraded, got %s", b.GetState())
	}

	// Only one becomes fresh — state stays degraded
	b.MarkDependencyFresh("bei")
	if b.GetState() != StateDegraded {
		t.Errorf("Still degraded while mats_ws is stale, got %s", b.GetState())
	}

	// Both fresh — recover to syncing
	b.MarkDependencyFresh("mats_ws")
	if b.GetState() != StateSyncing {
		t.Errorf("Expected syncing when all deps fresh, got %s", b.GetState())
	}
	if b.AnyStaleDependency() {
		t.Error("Expected no stale dependencies after both marked fresh")
	}
}

func TestBreakerDependencyStale_NoopWhenKillSwitch(t *testing.T) {
	b := NewBreakerManager()
	b.ActivateKillSwitch()

	b.MarkDependencyStale("account_stream")
	if b.GetState() != StateHalted {
		t.Errorf("Dependency stale should not override halted, got %s", b.GetState())
	}
}

// ── Spam Cooldown Tests ───────────────────────────────────────────────────────

func TestBreakerSpamCooldown(t *testing.T) {
	b := NewBreakerManager()

	b.ApplySpamCooldown("bot1", 100*time.Millisecond)

	if !b.IsBotSpamming("bot1") {
		t.Error("Expected bot1 to be in spam cooldown")
	}

	time.Sleep(150 * time.Millisecond)

	if b.IsBotSpamming("bot1") {
		t.Error("Expected bot1 cooldown to have expired")
	}
}

func TestBreakerSpamCooldown_UnknownBot(t *testing.T) {
	b := NewBreakerManager()
	if b.IsBotSpamming("unknown-bot") {
		t.Error("Unknown bot should not be considered spamming")
	}
}

// ── State Machine Completeness ────────────────────────────────────────────────

func TestReadinessStateTransitions(t *testing.T) {
	b := NewBreakerManager()

	// starting → syncing
	b.SetState(StateSyncing)
	if b.GetState() != StateSyncing {
		t.Errorf("starting → syncing failed, got %s", b.GetState())
	}

	// syncing → ready
	b.SetState(StateReady)
	if b.GetState() != StateReady {
		t.Errorf("syncing → ready failed, got %s", b.GetState())
	}

	// ready → degraded (via reject surge)
	for i := 0; i <= 101; i++ {
		b.RecordReject()
	}
	if b.GetState() != StateDegraded {
		t.Errorf("ready → degraded via reject surge failed, got %s", b.GetState())
	}

	// degraded → syncing (via ClearDegraded)
	b.ClearDegraded()
	if b.GetState() != StateSyncing {
		t.Errorf("degraded → syncing via ClearDegraded failed, got %s", b.GetState())
	}

	// syncing → halted (via kill switch)
	b.ActivateKillSwitch()
	if b.GetState() != StateHalted {
		t.Errorf("kill switch → halted failed, got %s", b.GetState())
	}

	// halted → starting (via ResetKillSwitch)
	b.ResetKillSwitch()
	if b.GetState() != StateStarting {
		t.Errorf("halted → starting via ResetKillSwitch failed, got %s", b.GetState())
	}
}
