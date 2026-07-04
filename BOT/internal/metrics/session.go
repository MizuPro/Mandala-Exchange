package metrics

import "sync"

type Counters struct {
	BotsEvaluated  int64
	Decisions      int64
	Enqueued       int64
	Dropped        int64
	Accepted       int64
	Filled         int64
	Rejected       int64
	Cancelled      int64
	Expired        int64
	PlaceCount     int64
	CancelCount    int64
	AmendCount     int64
	QueueDepth     int64
	LatencyTotalMs int64
	LatencyCount   int64
}

type Snapshot struct {
	SessionID     string
	Total         Counters
	ByStrategy    map[string]Counters
	RejectReasons map[string]int64
}

type Manager struct {
	mu            sync.RWMutex
	sessionID     string
	total         Counters
	byStrategy    map[string]Counters
	rejectReasons map[string]int64
}

func NewManager() *Manager {
	return &Manager{
		byStrategy:    make(map[string]Counters),
		rejectReasons: make(map[string]int64),
	}
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
	reasons := make(map[string]int64, len(m.rejectReasons))
	for k, v := range m.rejectReasons {
		reasons[k] = v
	}
	return Snapshot{
		SessionID:     m.sessionID,
		Total:         m.total,
		ByStrategy:    byStrategy,
		RejectReasons: reasons,
	}
}

func (m *Manager) ensureSession(sessionID string) {
	if sessionID == "" || m.sessionID == sessionID {
		return
	}
	m.sessionID = sessionID
	m.total = Counters{}
	m.byStrategy = make(map[string]Counters)
	m.rejectReasons = make(map[string]int64)
}

func (m *Manager) RecordAction(sessionID, strategy, action string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.ensureSession(sessionID)

	applyAction := func(counters *Counters) {
		switch action {
		case "place":
			counters.PlaceCount++
		case "cancel":
			counters.CancelCount++
		case "amend":
			counters.AmendCount++
		}
	}

	applyAction(&m.total)
	counters := m.byStrategy[strategy]
	applyAction(&counters)
	m.byStrategy[strategy] = counters
}

func (m *Manager) RecordLatency(sessionID, strategy string, durationMs int64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.ensureSession(sessionID)

	m.total.LatencyTotalMs += durationMs
	m.total.LatencyCount++

	counters := m.byStrategy[strategy]
	counters.LatencyTotalMs += durationMs
	counters.LatencyCount++
	m.byStrategy[strategy] = counters
}

func (m *Manager) RecordQueueDepth(sessionID string, depth int64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.ensureSession(sessionID)

	m.total.QueueDepth = depth
}

func (m *Manager) RecordRejectReason(sessionID, strategy, reason string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.ensureSession(sessionID)

	m.rejectReasons[reason]++
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
