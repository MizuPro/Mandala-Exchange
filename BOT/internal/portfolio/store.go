package portfolio

import (
	"encoding/json"
	"errors"
	"sync"
	"time"
)

var ErrSequenceGap = errors.New("account event sequence gap")

type Cash struct {
	AvailableIDR int64 `json:"available_idr,string"`
	ReservedIDR  int64 `json:"reserved_idr,string"`
	PendingIDR   int64 `json:"pending_idr,string"`
}

type Position struct {
	Symbol          string `json:"symbol"`
	AvailableShares int64  `json:"available_shares"`
	ReservedShares  int64  `json:"reserved_shares"`
	PendingShares   int64  `json:"pending_shares"`
	AveragePriceIDR int64  `json:"average_price_idr,string"`
}

type OpenOrder struct {
	OrderID              string `json:"order_id"`
	ClientOrderID        string `json:"client_order_id"`
	Symbol               string `json:"symbol"`
	Side                 string `json:"side"`
	Status               string `json:"status"`
	QuantityShares       int64  `json:"quantity_shares"`
	FilledQuantityShares int64  `json:"filled_quantity_shares"`
	EntityVersion        int64  `json:"entity_version"`
}

type Account struct {
	AccountID  string      `json:"account_id"`
	Cash       Cash        `json:"cash"`
	Positions  []Position  `json:"positions"`
	OpenOrders []OpenOrder `json:"open_orders"`
}

type Snapshot struct {
	AsOfSequence int64     `json:"as_of_sequence"`
	GeneratedAt  time.Time `json:"generated_at"`
	Accounts     []Account `json:"accounts"`
}

type Event struct {
	EventID       string          `json:"event_id"`
	Sequence      int64           `json:"sequence"`
	AccountID     string          `json:"account_id"`
	EventType     string          `json:"event_type"`
	EntityID      string          `json:"entity_id"`
	EntityVersion int64           `json:"entity_version"`
	OccurredAt    time.Time       `json:"occurred_at"`
	CorrelationID string          `json:"correlation_id"`
	Payload       json.RawMessage `json:"payload"`
}

type Store struct {
	mu           sync.RWMutex
	accounts     map[string]Account
	lastSequence int64
	seen         map[string]struct{}
}

func NewStore() *Store {
	return &Store{accounts: make(map[string]Account), seen: make(map[string]struct{})}
}

func (s *Store) Replace(snapshot Snapshot) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.accounts = make(map[string]Account, len(snapshot.Accounts))
	for _, account := range snapshot.Accounts {
		s.accounts[account.AccountID] = cloneAccount(account)
	}
	s.lastSequence = snapshot.AsOfSequence
	s.seen = make(map[string]struct{})
}

func (s *Store) Apply(event Event) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, duplicate := s.seen[event.EventID]; duplicate || event.Sequence <= s.lastSequence {
		return nil
	}
	if event.Sequence != s.lastSequence+1 {
		return ErrSequenceGap
	}
	if len(event.Payload) > 0 {
		var payload struct {
			Account *Account `json:"account"`
		}
		if err := json.Unmarshal(event.Payload, &payload); err != nil {
			return err
		}
		if payload.Account != nil {
			s.accounts[payload.Account.AccountID] = cloneAccount(*payload.Account)
		}
	}
	s.seen[event.EventID] = struct{}{}
	s.lastSequence = event.Sequence
	return nil
}

func (s *Store) LastSequence() int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.lastSequence
}

func (s *Store) Account(id string) (Account, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	account, ok := s.accounts[id]
	return cloneAccount(account), ok
}

func (s *Store) Compare(snapshot Snapshot) []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var mismatches []string
	for _, expected := range snapshot.Accounts {
		actual, ok := s.accounts[expected.AccountID]
		if !ok || !equalAccount(actual, expected) {
			mismatches = append(mismatches, expected.AccountID)
		}
	}
	return mismatches
}

func cloneAccount(in Account) Account {
	in.Positions = append([]Position(nil), in.Positions...)
	in.OpenOrders = append([]OpenOrder(nil), in.OpenOrders...)
	return in
}

func equalAccount(a, b Account) bool {
	if a.Cash != b.Cash || len(a.Positions) != len(b.Positions) || len(a.OpenOrders) != len(b.OpenOrders) {
		return false
	}
	for i := range a.Positions {
		if a.Positions[i] != b.Positions[i] {
			return false
		}
	}
	for i := range a.OpenOrders {
		if a.OpenOrders[i] != b.OpenOrders[i] {
			return false
		}
	}
	return true
}
