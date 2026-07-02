package marketrules

import (
	"sync"
)

// Store provides thread-safe access to the latest active market rules snapshot.
// The engine and strategies use this to resolve prices, ticks, and bounds without
// recompiling the BEI snapshot on every use.
type Store struct {
	mu       sync.RWMutex
	resolver *SnapshotResolver
}

// NewStore creates a new Store.
func NewStore() *Store {
	return &Store{}
}

// Update atomically replaces the active resolver.
func (s *Store) Update(resolver *SnapshotResolver) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.resolver = resolver
}

// Get returns the latest resolver. It returns nil if no rules have been set yet.
func (s *Store) Get() *SnapshotResolver {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.resolver
}
