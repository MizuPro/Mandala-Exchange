package registry

import "testing"

func TestInactiveDecisionIsStableWithinSession(t *testing.T) {
	bot := NewBotInstance("noise-0001", "account-1", "noise_trader")
	if !bot.IsInactiveForSession("session-1", 0.5, 0.1) {
		t.Fatal("expected bot to be inactive")
	}
	if !bot.IsInactiveForSession("session-1", 0.5, 0.9) {
		t.Fatal("inactive decision changed within the same session")
	}
	if bot.IsInactiveForSession("session-2", 0.5, 0.9) {
		t.Fatal("inactive decision did not reset for a new session")
	}
}
