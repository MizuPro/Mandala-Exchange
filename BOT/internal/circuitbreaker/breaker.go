package circuitbreaker

import (
	"sync"
	"time"
)

type ReadinessState string

const (
	StateStarting ReadinessState = "starting"
	StateSyncing  ReadinessState = "syncing"
	StateReady    ReadinessState = "ready"
	StateDegraded ReadinessState = "degraded"
	StateHalted   ReadinessState = "halted"
)

type BreakerManager struct {
	mu              sync.RWMutex
	globalState     ReadinessState
	killSwitch      bool
	rejectCount     int
	rejectLimit     int
	rejectWindow    time.Duration
	lastRejectReset time.Time

	spamCooldowns map[string]time.Time
}

func NewBreakerManager() *BreakerManager {
	return &BreakerManager{
		globalState:     StateStarting,
		spamCooldowns:   make(map[string]time.Time),
		rejectLimit:     100, // 100 rejects per window trips the breaker
		rejectWindow:    1 * time.Minute,
		lastRejectReset: time.Now(),
	}
}

func (m *BreakerManager) GetState() ReadinessState {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.globalState
}

func (m *BreakerManager) SetState(state ReadinessState) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.globalState = state
}

func (m *BreakerManager) ActivateKillSwitch() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.killSwitch = true
	m.globalState = StateHalted
}

func (m *BreakerManager) IsKillSwitchActive() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.killSwitch
}

func (m *BreakerManager) RecordReject() {
	m.mu.Lock()
	defer m.mu.Unlock()

	now := time.Now()
	if now.Sub(m.lastRejectReset) > m.rejectWindow {
		m.rejectCount = 0
		m.lastRejectReset = now
	}

	m.rejectCount++
	if m.rejectCount > m.rejectLimit && m.globalState != StateHalted {
		m.globalState = StateDegraded // Reject surge trips to degraded
	}
}

func (m *BreakerManager) ApplySpamCooldown(botID string, duration time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.spamCooldowns[botID] = time.Now().Add(duration)
}

func (m *BreakerManager) IsBotSpamming(botID string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	cooldownUntil, ok := m.spamCooldowns[botID]
	if !ok {
		return false
	}
	return time.Now().Before(cooldownUntil)
}
