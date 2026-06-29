package circuitbreaker

import (
	"testing"
	"time"
)

func TestBreakerRejectSurge(t *testing.T) {
	b := NewBreakerManager()

	for i := 0; i < 100; i++ {
		b.RecordReject()
	}

	if b.GetState() != StateStarting {
		t.Errorf("Expected state to be starting, got %s", b.GetState())
	}

	// This one should trip it
	b.RecordReject()

	if b.GetState() != StateDegraded {
		t.Errorf("Expected state to be degraded, got %s", b.GetState())
	}
}

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

func TestBreakerSpamCooldown(t *testing.T) {
	b := NewBreakerManager()

	b.ApplySpamCooldown("bot1", 100*time.Millisecond)

	if !b.IsBotSpamming("bot1") {
		t.Error("Expected bot1 to be spamming")
	}

	time.Sleep(150 * time.Millisecond)

	if b.IsBotSpamming("bot1") {
		t.Error("Expected bot1 to not be spamming anymore")
	}
}
