package session

import (
	"sync"
	"time"

	"github.com/google/uuid"
)

type SessionState string

const (
	StatePreOpen  SessionState = "PRE_OPEN"
	StateOpen     SessionState = "OPEN"
	StatePreClose SessionState = "PRE_CLOSE"
	StateClosed   SessionState = "CLOSED"
)

type SessionInstance struct {
	InstanceID          uuid.UUID
	VirtualDayIndex     int
	VirtualDurationSecs int
	RealDurationSecs    int
	State               SessionState
	StartedAt           time.Time
}

type Monitor struct {
	mu         sync.RWMutex
	instance   *SessionInstance
	onRollover func(previous, current SessionInstance)
}

func NewMonitor() *Monitor {
	return &Monitor{}
}

func (m *Monitor) OnRollover(callback func(previous, current SessionInstance)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.onRollover = callback
}

func (m *Monitor) UpdateInstance(instance *SessionInstance) {
	if instance == nil || instance.InstanceID == uuid.Nil || instance.VirtualDurationSecs <= 0 || instance.RealDurationSecs <= 0 {
		return
	}
	m.mu.Lock()
	current := *instance
	var previous *SessionInstance
	if m.instance != nil {
		copy := *m.instance
		previous = &copy
	}
	if previous != nil && current.VirtualDayIndex < previous.VirtualDayIndex {
		m.mu.Unlock()
		return
	}
	m.instance = &current
	callback := m.onRollover
	m.mu.Unlock()
	if previous != nil && previous.InstanceID != current.InstanceID && callback != nil {
		callback(*previous, current)
	}
}

func (m *Monitor) GetInstance() *SessionInstance {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.instance == nil {
		return nil
	}
	// return copy to avoid data race
	copy := *m.instance
	return &copy
}

func (m *Monitor) VirtualToRealDelay(virtualDelay time.Duration) time.Duration {
	m.mu.RLock()
	defer m.mu.RUnlock()

	if m.instance == nil || m.instance.VirtualDurationSecs == 0 {
		return virtualDelay // fallback to 1:1
	}

	ratio := float64(m.instance.RealDurationSecs) / float64(m.instance.VirtualDurationSecs)
	realNanos := float64(virtualDelay.Nanoseconds()) * ratio

	return time.Duration(realNanos)
}
