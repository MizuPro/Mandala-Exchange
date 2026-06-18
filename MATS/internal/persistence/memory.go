package persistence

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"mandala-exchange/mats/internal/domain"
)

var timeNow = func() time.Time {
	return time.Now().UTC()
}

type MemoryStore struct {
	mu                 sync.RWMutex
	orders             map[string]*domain.Order
	trades             map[string]*domain.Trade
	events             []Event
	deliveries         map[string]DeliveryEvent
	idempotencyRecords map[string]IdempotencyRecord
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		orders:             make(map[string]*domain.Order),
		trades:             make(map[string]*domain.Trade),
		deliveries:         make(map[string]DeliveryEvent),
		idempotencyRecords: make(map[string]IdempotencyRecord),
	}
}

func (s *MemoryStore) Ping(context.Context) error {
	return nil
}

func (s *MemoryStore) SaveOrder(_ context.Context, order *domain.Order) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.orders[order.ID] = order.Clone()
	return nil
}

func (s *MemoryStore) UpdateOrder(ctx context.Context, order *domain.Order) error {
	return s.SaveOrder(ctx, order)
}

func (s *MemoryStore) FindOrderByID(_ context.Context, id string) (*domain.Order, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	order, ok := s.orders[id]
	if !ok {
		return nil, ErrNotFound
	}
	return order.Clone(), nil
}

func (s *MemoryStore) FindOrderByIdempotency(_ context.Context, key string) (*domain.Order, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, order := range s.orders {
		if order.IdempotencyKey == key {
			return order.Clone(), nil
		}
	}
	return nil, ErrNotFound
}

func (s *MemoryStore) SaveIdempotencyRecord(_ context.Context, record IdempotencyRecord) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if record.CreatedAt.IsZero() {
		record.CreatedAt = timeNow()
	}
	if _, exists := s.idempotencyRecords[record.Key]; !exists {
		s.idempotencyRecords[record.Key] = record
	}
	return nil
}

func (s *MemoryStore) FindIdempotencyRecord(_ context.Context, key string) (*IdempotencyRecord, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	record, ok := s.idempotencyRecords[key]
	if !ok {
		return nil, ErrNotFound
	}
	return &record, nil
}

func (s *MemoryStore) LoadOpenOrders(context.Context) ([]*domain.Order, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	orders := make([]*domain.Order, 0)
	for _, order := range s.orders {
		if order.IsActive() && order.RemainingQuantity > 0 {
			orders = append(orders, order.Clone())
		}
	}
	return orders, nil
}

func (s *MemoryStore) SaveTrade(_ context.Context, trade *domain.Trade) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	clone := *trade
	s.trades[trade.ID] = &clone
	return nil
}

func (s *MemoryStore) WakeUpPendingSessionClosedFinality(_ context.Context, sessionID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := timeNow()
	for id, event := range s.deliveries {
		var payload struct {
			SessionID string `json:"session_id"`
		}
		data, err := json.Marshal(event.Payload)
		if err != nil {
			continue
		}
		if err := json.Unmarshal(data, &payload); err != nil {
			continue
		}
		if event.EventType == "session_closed_finality" && (event.Status == "pending" || event.Status == "dead") && payload.SessionID == sessionID {
			event.Status = "pending"
			event.NextAttemptAt = now
			event.UpdatedAt = now
			s.deliveries[id] = event
		}
	}
	return nil
}

func (s *MemoryStore) CountSessionTrades(_ context.Context, sessionID string) (int, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	count := 0
	for _, trade := range s.trades {
		if trade.SessionID == sessionID {
			count++
		}
	}
	return count, nil
}

func (s *MemoryStore) FindTradesByOrderID(_ context.Context, orderID string) ([]domain.Trade, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	trades := make([]domain.Trade, 0)
	for _, trade := range s.trades {
		if trade.BuyOrderID == orderID || trade.SellOrderID == orderID {
			trades = append(trades, *trade)
		}
	}
	return trades, nil
}

func (s *MemoryStore) AppendEvent(_ context.Context, event Event) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.events = append(s.events, event)
	return nil
}

func (s *MemoryStore) SaveDeliveryEvent(_ context.Context, event DeliveryEvent) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := event.CreatedAt
	if now.IsZero() {
		now = event.UpdatedAt
	}
	if now.IsZero() {
		now = event.NextAttemptAt
	}
	if now.IsZero() {
		now = timeNow()
	}
	if event.CreatedAt.IsZero() {
		event.CreatedAt = now
	}
	if event.UpdatedAt.IsZero() {
		event.UpdatedAt = now
	}
	if event.NextAttemptAt.IsZero() {
		event.NextAttemptAt = now
	}
	if event.Status == "" {
		event.Status = "pending"
	}
	if event.MaxAttempts <= 0 {
		event.MaxAttempts = 5
	}
	if _, exists := s.deliveries[event.ID]; !exists {
		s.deliveries[event.ID] = event
	}
	return nil
}

func (s *MemoryStore) UpdateDeliveryEvent(_ context.Context, event DeliveryEvent) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.deliveries[event.ID]; !ok {
		return ErrNotFound
	}
	event.UpdatedAt = timeNow()
	s.deliveries[event.ID] = event
	return nil
}

func (s *MemoryStore) LoadDueDeliveryEvents(_ context.Context, limit int) ([]DeliveryEvent, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if limit <= 0 {
		limit = 100
	}
	now := timeNow()
	events := make([]DeliveryEvent, 0)
	for _, event := range s.deliveries {
		if event.Status == "pending" && !event.NextAttemptAt.After(now) {
			events = append(events, event)
			if len(events) >= limit {
				break
			}
		}
	}
	return events, nil
}

func (s *MemoryStore) ListDeliveryEvents(_ context.Context, status string, limit int) ([]DeliveryEvent, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if limit <= 0 {
		limit = 100
	}
	events := make([]DeliveryEvent, 0)
	for _, event := range s.deliveries {
		if status == "" || event.Status == status {
			events = append(events, event)
			if len(events) >= limit {
				break
			}
		}
	}
	return events, nil
}

func (s *MemoryStore) RequeueDeadDeliveryEvent(_ context.Context, eventID string) (*DeliveryEvent, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	event, ok := s.deliveries[eventID]
	if !ok || event.Status != "dead" {
		return nil, ErrNotFound
	}
	event.Status = "pending"
	event.LastError = ""
	event.NextAttemptAt = timeNow()
	event.MaxAttempts += 3
	event.UpdatedAt = timeNow()
	s.deliveries[eventID] = event
	return &event, nil
}
