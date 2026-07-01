package circuitbreaker

import (
	"sync"
	"time"
)

// ReadinessState represents the BOT service readiness lifecycle.
// Valid transitions: starting → syncing → ready → degraded → halted
// Recovery: halted → starting (via ResetKillSwitch, admin-only action)
// degraded → syncing (via ClearDegraded after root cause resolved)
type ReadinessState string

const (
	StateStarting ReadinessState = "starting"
	StateSyncing  ReadinessState = "syncing"
	StateReady    ReadinessState = "ready"
	StateDegraded ReadinessState = "degraded"
	StateHalted   ReadinessState = "halted"
)

// BreakerManager manages all circuit breaker conditions for the BOT service:
//
//  1. Per-bot spam cooldown — slows individual bots that submit too fast
//  2. Reject surge breaker — trips to degraded when reject rate spikes (>100/min)
//  3. Queue pressure breaker — trips to degraded when queue fill ratio exceeds threshold
//  4. Dependency stale breaker — trips to degraded when external dependencies are stale
//  5. Kill switch — admin-activated; trips to halted; recoverable via ResetKillSwitch
//
// The readiness state machine is:
//
//	starting → syncing → ready → degraded → halted
//	halted → starting (via ResetKillSwitch — admin action)
//	degraded → syncing (via ClearDegraded — after root cause resolved)
type BreakerManager struct {
	mu              sync.RWMutex
	globalState     ReadinessState
	killSwitch      bool
	rejectCount     int
	rejectLimit     int
	rejectWindow    time.Duration
	lastRejectReset time.Time

	// Queue pressure
	queuePressureThreshold float64 // trip ratio: e.g. 0.80 = 80% full

	// Dependency stale tracking
	dependencyStale map[string]bool // key: dependency name (e.g. "bei", "mats_ws", "account_stream")

	// Per-bot spam cooldowns
	spamCooldowns map[string]time.Time
}

// NewBreakerManager creates a BreakerManager with production defaults.
func NewBreakerManager() *BreakerManager {
	return &BreakerManager{
		globalState:            StateStarting,
		spamCooldowns:          make(map[string]time.Time),
		rejectLimit:            100, // 100 rejects per window trips to degraded
		rejectWindow:           1 * time.Minute,
		lastRejectReset:        time.Now(),
		queuePressureThreshold: 0.80, // 80% queue fill trips to degraded
		dependencyStale:        make(map[string]bool),
	}
}

// ── Readiness State ───────────────────────────────────────────────────────────

// GetState returns the current readiness state.
func (m *BreakerManager) GetState() ReadinessState {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.globalState
}

// SetState transitions to the given state. This is safe to call from any goroutine.
// It does not override halted (kill switch active) unless explicitly reset.
func (m *BreakerManager) SetState(state ReadinessState) {
	m.mu.Lock()
	defer m.mu.Unlock()
	// Do not override halted state — kill switch must be explicitly reset
	if m.killSwitch {
		return
	}
	m.globalState = state
}

// ── Kill Switch ───────────────────────────────────────────────────────────────

// ActivateKillSwitch is an admin-activated emergency stop.
// Transitions immediately to halted. Survives all other state updates.
func (m *BreakerManager) ActivateKillSwitch() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.killSwitch = true
	m.globalState = StateHalted
}

// IsKillSwitchActive returns true if the kill switch has been activated.
func (m *BreakerManager) IsKillSwitchActive() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.killSwitch
}

// ResetKillSwitch deactivates the kill switch and transitions back to starting.
// This is an admin-only recovery action. After reset, the service must re-sync
// dependencies before transitioning to ready.
func (m *BreakerManager) ResetKillSwitch() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.killSwitch = false
	m.globalState = StateStarting
}

// ── Reject Surge Breaker ─────────────────────────────────────────────────────

// RecordReject increments the reject counter.
// If rejects exceed the limit within the window, trips to degraded.
func (m *BreakerManager) RecordReject() {
	m.mu.Lock()
	defer m.mu.Unlock()

	now := time.Now()
	if now.Sub(m.lastRejectReset) > m.rejectWindow {
		m.rejectCount = 0
		m.lastRejectReset = now
	}

	m.rejectCount++
	if m.rejectCount > m.rejectLimit && m.globalState == StateReady && !m.killSwitch {
		m.globalState = StateDegraded
	}
}

// ── Queue Pressure Breaker ───────────────────────────────────────────────────

// RecordQueuePressure reports the current queue fill ratio (currentSize / maxSize).
// If the ratio exceeds queuePressureThreshold (80%), trips to degraded.
// This prevents the queue from silently overflowing.
func (m *BreakerManager) RecordQueuePressure(currentSize, maxSize int) {
	if maxSize <= 0 {
		return
	}
	ratio := float64(currentSize) / float64(maxSize)

	m.mu.Lock()
	defer m.mu.Unlock()

	if m.killSwitch {
		return
	}
	if ratio >= m.queuePressureThreshold && m.globalState == StateReady {
		m.globalState = StateDegraded
	}
}

// ClearQueuePressure is called when the queue fill ratio has dropped below
// threshold. Transitions from degraded → syncing so dependencies can be re-checked.
func (m *BreakerManager) ClearQueuePressure(currentSize, maxSize int) {
	if maxSize <= 0 {
		return
	}
	ratio := float64(currentSize) / float64(maxSize)

	m.mu.Lock()
	defer m.mu.Unlock()

	if m.killSwitch {
		return
	}
	// Only recover if queue is now below threshold
	if ratio < m.queuePressureThreshold && m.globalState == StateDegraded {
		m.globalState = StateSyncing
	}
}

// ── Dependency Stale Breaker ─────────────────────────────────────────────────

// MarkDependencyStale records that a named dependency (e.g. "bei", "mats_ws",
// "account_stream") has become stale. Trips to degraded if currently ready.
// Per PRD: fail-closed if rules/session/account stream stale.
func (m *BreakerManager) MarkDependencyStale(name string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.dependencyStale[name] = true
	if m.killSwitch {
		return
	}
	if m.globalState == StateReady {
		m.globalState = StateDegraded
	}
}

// MarkDependencyFresh records that a named dependency is now fresh.
// If all dependencies are fresh and state is degraded, transitions to syncing.
func (m *BreakerManager) MarkDependencyFresh(name string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	delete(m.dependencyStale, name)
	if m.killSwitch {
		return
	}
	// Only recover from degraded if ALL dependencies are now fresh
	if len(m.dependencyStale) == 0 && m.globalState == StateDegraded {
		m.globalState = StateSyncing
	}
}

// HasStaleDependency returns true if the named dependency is currently stale.
func (m *BreakerManager) HasStaleDependency(name string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.dependencyStale[name]
}

// AnyStaleDependency returns true if any dependency is currently stale.
func (m *BreakerManager) AnyStaleDependency() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.dependencyStale) > 0
}

// ClearDegraded transitions from degraded → syncing when the caller has
// confirmed the root cause is resolved. This is a safe no-op in any other state.
func (m *BreakerManager) ClearDegraded() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.killSwitch {
		return
	}
	if m.globalState == StateDegraded {
		m.globalState = StateSyncing
	}
}

// ── Per-bot Spam Cooldown ────────────────────────────────────────────────────

// ApplySpamCooldown puts a bot into spam cooldown for the given duration.
// While cooling down, the bot should not submit new orders.
func (m *BreakerManager) ApplySpamCooldown(botID string, duration time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.spamCooldowns[botID] = time.Now().Add(duration)
}

// IsBotSpamming returns true if the bot is currently in spam cooldown.
func (m *BreakerManager) IsBotSpamming(botID string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	cooldownUntil, ok := m.spamCooldowns[botID]
	if !ok {
		return false
	}
	return time.Now().Before(cooldownUntil)
}
