package session

import (
	"sync"
	"time"

	"github.com/google/uuid"
)

// SessionState represents the current trading segment state reported by BEI/MATS.
// Per BOT_STATE_MACHINES.md §12 and BOT_API_CONTRACTS.md §10.
type SessionState string

const (
	StatePreOpen         SessionState = "pre_open"
	StateOpeningAuction  SessionState = "opening_auction"
	StateContinuous      SessionState = "continuous"
	StatePreClose        SessionState = "pre_close"
	StateNonCancellation SessionState = "non_cancellation"
	StateClosingAuction  SessionState = "closing_auction"
	StatePostTrading     SessionState = "post_trading"
	StateClosed          SessionState = "closed"
	StateFinalized       SessionState = "finalized"
)

// SessionInstance represents a single trading session instance.
// BEI is the owner and persistence authority; this is a local cache copy.
// Per BOT_API_CONTRACTS.md §10: virtual_day_index is unique and monotonic.
type SessionInstance struct {
	InstanceID          uuid.UUID    `json:"session_instance_id"`
	VirtualDayIndex     int          `json:"virtual_day_index"`
	VirtualDurationSecs int          `json:"virtual_duration_seconds"`
	RealDurationSecs    int          `json:"real_duration_seconds"`
	RealTimeRemainSecs  int          `json:"real_time_remaining_seconds"`
	Status              SessionState `json:"status"`
	StartedAt           time.Time    `json:"started_at"`
	ExpectedEndAt       time.Time    `json:"expected_end_at"`
	Version             int64        `json:"version"`
}

// Monitor tracks the current session instance and emits rollover callbacks.
// Per BOT_MAIN_PLAN.md Task 2.8: uses session instance as daily boundary;
// converts virtual delay to real delay from duration/progress of session;
// handles reconnect and rollover.
//
// Invariants (BOT_STATE_MACHINES.md §16):
//   - virtual_day_index is monotonically increasing; never decreases.
//   - A rollover fires exactly once when InstanceID changes.
//   - VirtualDurationSecs and RealDurationSecs must be positive for a valid instance.
type Monitor struct {
	mu         sync.RWMutex
	instance   *SessionInstance
	onRollover func(previous, current SessionInstance)
}

// NewMonitor creates a Monitor with no active session.
func NewMonitor() *Monitor {
	return &Monitor{}
}

// OnRollover registers a callback invoked when the session rolls over to a new instance.
// The callback receives the previous and the new current instance.
// Only the most recently registered callback is used.
func (m *Monitor) OnRollover(callback func(previous, current SessionInstance)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.onRollover = callback
}

// UpdateInstance atomically updates the current session instance.
// Silently ignores invalid or regressed instances (monotonicity invariant).
//
// Invariant checks:
//   - InstanceID must not be zero UUID.
//   - VirtualDurationSecs and RealDurationSecs must be positive.
//   - VirtualDayIndex must not decrease from the previously held instance.
//
// The rollover callback is called outside the lock to avoid deadlocks.
func (m *Monitor) UpdateInstance(instance *SessionInstance) {
	if instance == nil ||
		instance.InstanceID == uuid.Nil ||
		instance.VirtualDurationSecs <= 0 ||
		instance.RealDurationSecs <= 0 {
		return
	}

	m.mu.Lock()
	current := *instance // defensive copy

	var previous *SessionInstance
	if m.instance != nil {
		prev := *m.instance
		previous = &prev
	}

	// Monotonicity: never accept a lower virtual_day_index.
	if previous != nil && current.VirtualDayIndex < previous.VirtualDayIndex {
		m.mu.Unlock()
		return
	}

	m.instance = &current
	callback := m.onRollover
	m.mu.Unlock()

	// Rollover fires when InstanceID changes (even if VirtualDayIndex is the same
	// due to a server restart mid-session, though normal rollover = new VirtualDayIndex).
	if previous != nil && previous.InstanceID != current.InstanceID && callback != nil {
		callback(*previous, current)
	}
}

// GetInstance returns a copy of the current session instance, or nil if none.
// Always returns a copy — callers cannot mutate the cached instance.
func (m *Monitor) GetInstance() *SessionInstance {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.instance == nil {
		return nil
	}
	copy := *m.instance
	return &copy
}

// IsActive returns true if the current session is in an actively trading state.
// Per BOT_STATE_MACHINES.md §12: strategies may submit orders only during
// active segments (opening_auction, continuous, closing_auction).
func (m *Monitor) IsActive() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.instance == nil {
		return false
	}
	switch m.instance.Status {
	case StateOpeningAuction, StateContinuous, StateClosingAuction:
		return true
	}
	return false
}

// IsNonCancellation returns true if the session is in NCP (Non-Cancellation Period).
// During NCP, orders cannot be cancelled and must be tracked until terminal.
// Per BOT_STATE_MACHINES.md §4.4: NCP orders are tracked as cancel_deferred_by_market_rule.
func (m *Monitor) IsNonCancellation() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.instance == nil {
		return false
	}
	return m.instance.Status == StateNonCancellation
}

// VirtualToRealDelay converts a virtual time duration to a real wall-clock duration
// based on the current session's virtual/real duration ratio.
//
// Formula: real = virtual × (real_duration / virtual_duration)
//
// Falls back to 1:1 ratio if no session is loaded (safe default for startup).
// Per BOT_MAIN_PLAN.md Task 2.8: compressed virtual delays must be calculated
// from the session progress, not a fixed ratio.
func (m *Monitor) VirtualToRealDelay(virtualDelay time.Duration) time.Duration {
	m.mu.RLock()
	defer m.mu.RUnlock()

	if m.instance == nil || m.instance.VirtualDurationSecs == 0 {
		return virtualDelay // fallback: 1:1
	}

	ratio := float64(m.instance.RealDurationSecs) / float64(m.instance.VirtualDurationSecs)
	realNanos := float64(virtualDelay.Nanoseconds()) * ratio
	return time.Duration(realNanos)
}

// RealTimeRemaining returns the estimated real wall-clock time remaining in the
// current session, or zero if no session is loaded.
func (m *Monitor) RealTimeRemaining() time.Duration {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.instance == nil {
		return 0
	}
	return time.Duration(m.instance.RealTimeRemainSecs) * time.Second
}

// SessionProgress returns a value in [0, 1] representing how far through
// the current real-time session we are. Returns 0 if not started or unknown.
func (m *Monitor) SessionProgress() float64 {
	return m.SessionProgressAt(time.Now())
}

// SessionProgressAt is the deterministic form used by tests and replay.
func (m *Monitor) SessionProgressAt(now time.Time) float64 {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.instance == nil || m.instance.RealDurationSecs == 0 {
		return 0
	}
	elapsed := now.Sub(m.instance.StartedAt).Seconds()
	total := float64(m.instance.RealDurationSecs)
	if elapsed >= total {
		return 1.0
	}
	if elapsed <= 0 {
		return 0
	}
	return elapsed / total
}
