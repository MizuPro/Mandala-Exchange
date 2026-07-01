package strategystate

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"sync"
)

// Manager owns in-memory strategy memory only. Portfolio/order state remains
// authoritative in Sekuritas and is never restored from these snapshots.
type Manager struct {
	repository Repository
	mu         sync.RWMutex
	states     map[string]Snapshot
	dirty      map[string]struct{}
}

func NewManager(repository Repository) *Manager {
	return &Manager{
		repository: repository,
		states:     make(map[string]Snapshot),
		dirty:      make(map[string]struct{}),
	}
}

func (m *Manager) Restore(ctx context.Context) error {
	snapshots, err := m.repository.LoadLatest(ctx)
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, snapshot := range snapshots {
		if err := snapshot.Validate(); err != nil {
			return fmt.Errorf("invalid persisted state for bot %s: %w", snapshot.BotID, err)
		}
		m.states[snapshot.BotID] = clone(snapshot)
	}
	return nil
}

func (m *Manager) Get(botID string) (Snapshot, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	snapshot, ok := m.states[botID]
	return clone(snapshot), ok
}

// Track updates strategy memory without persistence. It is intended for
// non-material changes and guarantees the latest memory is flushed at shutdown.
func (m *Manager) Track(snapshot Snapshot) error {
	if snapshot.Reason == "" {
		snapshot.Reason = ReasonMaterialChange
	}
	if err := snapshot.Validate(); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if current, ok := m.states[snapshot.BotID]; ok {
		if current.Strategy != snapshot.Strategy {
			return errors.New("strategy type cannot change within an active state")
		}
		snapshot.StateVersion = current.StateVersion
	}
	m.states[snapshot.BotID] = clone(snapshot)
	m.dirty[snapshot.BotID] = struct{}{}
	return nil
}

func (m *Manager) PersistTransition(ctx context.Context, snapshot Snapshot) (Snapshot, error) {
	snapshot.Reason = ReasonTransition
	return m.persist(ctx, snapshot)
}

func (m *Manager) PersistMaterialChange(ctx context.Context, snapshot Snapshot) (Snapshot, error) {
	snapshot.Reason = ReasonMaterialChange
	return m.persist(ctx, snapshot)
}

func (m *Manager) persist(ctx context.Context, snapshot Snapshot) (Snapshot, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if current, ok := m.states[snapshot.BotID]; ok {
		snapshot.StateVersion = current.StateVersion
	}
	saved, err := m.repository.Save(ctx, snapshot)
	if err != nil {
		return Snapshot{}, err
	}
	m.states[saved.BotID] = clone(saved)
	delete(m.dirty, saved.BotID)
	return clone(saved), nil
}

// Flush persists every dirty state in deterministic bot-ID order. A failure
// leaves that state dirty so shutdown can report the incomplete durability.
func (m *Manager) Flush(ctx context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	ids := make([]string, 0, len(m.dirty))
	for id := range m.dirty {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	var errs []error
	for _, id := range ids {
		snapshot := m.states[id]
		snapshot.Reason = ReasonShutdown
		saved, err := m.repository.Save(ctx, snapshot)
		if err != nil {
			errs = append(errs, fmt.Errorf("flush bot %s: %w", id, err))
			continue
		}
		m.states[id] = clone(saved)
		delete(m.dirty, id)
	}
	return errors.Join(errs...)
}
