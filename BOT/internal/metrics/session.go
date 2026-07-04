package metrics

import "sync"

type Counters struct {
	BotsEvaluated int64
	Decisions     int64
	Enqueued      int64
	Dropped       int64
	Accepted      int64
	Filled        int64
	Rejected      int64
	Cancelled     int64
	Expired       int64
}

type Snapshot struct {
	SessionID  string
	Total      Counters
	ByStrategy map[string]Counters
}

type Manager struct {
	mu         sync.RWMutex
	sessionID  string
	total      Counters
	byStrategy map[string]Counters
}

func NewManager() *Manager {
	return &Manager{byStrategy: make(map[string]Counters)}
}

func (m *Manager) RecordRunner(sessionID, strategy string, evaluated, decisions, enqueued, dropped int64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.ensureSession(sessionID)
	m.total.BotsEvaluated += evaluated
	m.total.Decisions += decisions
	m.total.Enqueued += enqueued
	m.total.Dropped += dropped
	counters := m.byStrategy[strategy]
	counters.BotsEvaluated += evaluated
	counters.Decisions += decisions
	counters.Enqueued += enqueued
	counters.Dropped += dropped
	m.byStrategy[strategy] = counters
}

func (m *Manager) RecordEvent(sessionID, strategy, eventType string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.ensureSession(sessionID)
	applyEvent(&m.total, eventType)
	counters := m.byStrategy[strategy]
	applyEvent(&counters, eventType)
	m.byStrategy[strategy] = counters
}

func (m *Manager) Snapshot() Snapshot {
	m.mu.RLock()
	defer m.mu.RUnlock()
	byStrategy := make(map[string]Counters, len(m.byStrategy))
	for strategy, counters := range m.byStrategy {
		byStrategy[strategy] = counters
	}
	return Snapshot{SessionID: m.sessionID, Total: m.total, ByStrategy: byStrategy}
}

func (m *Manager) ensureSession(sessionID string) {
	if sessionID == "" || m.sessionID == sessionID {
		return
	}
	m.sessionID = sessionID
	m.total = Counters{}
	m.byStrategy = make(map[string]Counters)
}

func applyEvent(counters *Counters, eventType string) {
	switch eventType {
	case "order_accepted":
		counters.Accepted++
	case "order_filled":
		counters.Filled++
	case "order_rejected":
		counters.Rejected++
	case "order_cancelled":
		counters.Cancelled++
	case "order_expired":
		counters.Expired++
	}
}
