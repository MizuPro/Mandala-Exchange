package matching

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"mandala-exchange/mats/internal/domain"
	"mandala-exchange/mats/internal/marketdata"
	"mandala-exchange/mats/internal/sequence"
)

var ErrOrderNotFound = errors.New("order not found")

type Engine struct {
	mu        sync.Mutex
	books     map[string]*Book
	orders    map[string]*domain.Order
	seq       sequence.Generator
	sessionID string
	summaries *marketdata.SummaryStore
}

func NewEngine(seq sequence.Generator, sessionID string, summaries *marketdata.SummaryStore) *Engine {
	return &Engine{
		books:     make(map[string]*Book),
		orders:    make(map[string]*domain.Order),
		seq:       seq,
		sessionID: sessionID,
		summaries: summaries,
	}
}

func (e *Engine) Recover(orders []*domain.Order) {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, order := range orders {
		clone := order.Clone()
		e.orders[clone.ID] = clone
		if clone.IsActive() && clone.RemainingQuantity > 0 {
			e.book(clone.Symbol).Add(clone)
		}
	}
}

func (e *Engine) Place(ctx context.Context, order *domain.Order) ([]domain.Trade, []*domain.Order, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.orders[order.ID] = order
	book := e.book(order.Symbol)
	trades, updatedResting, err := book.Match(order, func(resting *domain.Order, price, quantity int64) (domain.Trade, error) {
		sequenceNumber, err := e.seq.Next(ctx)
		if err != nil {
			return domain.Trade{}, err
		}
		trade := makeTrade(sequenceNumber, e.sessionID, order, resting, price, quantity)
		if e.summaries != nil {
			e.summaries.ApplyTrade(trade)
		}
		return trade, nil
	})
	if err != nil {
		return nil, nil, err
	}
	for _, resting := range updatedResting {
		if existing, ok := e.orders[resting.ID]; ok {
			*existing = *resting
		}
	}
	return trades, updatedResting, nil
}

func (e *Engine) PlaceAuction(order *domain.Order) {
	e.mu.Lock()
	defer e.mu.Unlock()
	order.Status = domain.OrderStatusOpen
	order.UpdatedAt = time.Now().UTC()
	e.orders[order.ID] = order
	e.book(order.Symbol).Add(order)
}

func (e *Engine) Amend(ctx context.Context, orderID string, price *int64, quantity *int64, sequenceNumber int64) (*domain.Order, []domain.Trade, []*domain.Order, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	order, ok := e.orders[orderID]
	if !ok {
		return nil, nil, nil, ErrOrderNotFound
	}
	if !order.IsActive() || order.RemainingQuantity <= 0 {
		return nil, nil, nil, fmt.Errorf("order_not_open")
	}

	book := e.book(order.Symbol)
	book.Remove(order.ID)
	if price != nil {
		order.Price = *price
	}
	if quantity != nil {
		if *quantity < order.FilledQuantity {
			return nil, nil, nil, fmt.Errorf("quantity_below_filled_quantity")
		}
		order.OriginalQuantity = *quantity
		order.RemainingQuantity = *quantity - order.FilledQuantity
	}
	order.SequenceNumber = sequenceNumber
	order.Status = domain.OrderStatusAmended
	order.UpdatedAt = time.Now().UTC()

	trades, updatedResting, err := book.Match(order, func(resting *domain.Order, price, quantity int64) (domain.Trade, error) {
		sequence, err := e.seq.Next(ctx)
		if err != nil {
			return domain.Trade{}, err
		}
		trade := makeTrade(sequence, e.sessionID, order, resting, price, quantity)
		if e.summaries != nil {
			e.summaries.ApplyTrade(trade)
		}
		return trade, nil
	})
	if err != nil {
		return nil, nil, nil, err
	}
	for _, resting := range updatedResting {
		if existing, ok := e.orders[resting.ID]; ok {
			*existing = *resting
		}
	}
	return order.Clone(), trades, updatedResting, nil
}

func (e *Engine) Cancel(orderID string) (*domain.Order, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	order, ok := e.orders[orderID]
	if !ok {
		return nil, ErrOrderNotFound
	}
	if !order.IsActive() || order.RemainingQuantity <= 0 {
		return nil, fmt.Errorf("order_not_open")
	}
	e.book(order.Symbol).Remove(order.ID)
	order.RemainingQuantity = 0
	order.Status = domain.OrderStatusCancelled
	order.UpdatedAt = time.Now().UTC()
	return order.Clone(), nil
}

func (e *Engine) ExpireOpenOrders() []*domain.Order {
	e.mu.Lock()
	defer e.mu.Unlock()
	expired := make([]*domain.Order, 0)
	for _, order := range e.orders {
		if !order.IsActive() || order.RemainingQuantity <= 0 {
			continue
		}
		e.book(order.Symbol).Remove(order.ID)
		order.RemainingQuantity = 0
		order.Status = domain.OrderStatusExpired
		order.UpdatedAt = time.Now().UTC()
		expired = append(expired, order.Clone())
	}
	return expired
}

func (e *Engine) SessionState() domain.SessionStatus {
	return domain.SessionContinuous
}

func (e *Engine) Get(orderID string) (*domain.Order, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	order, ok := e.orders[orderID]
	if !ok {
		return nil, false
	}
	return order.Clone(), true
}

func (e *Engine) Snapshot(symbol string) domain.BookSnapshot {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.book(symbol).Snapshot()
}

func (e *Engine) Indicative(symbol string, referencePrice int64) domain.IndicativePriceVolume {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.book(symbol).Indicative(referencePrice)
}

func (e *Engine) UncrossAuction(ctx context.Context, symbol string, referencePrice int64) (domain.IndicativePriceVolume, []domain.Trade, []*domain.Order, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	book := e.book(symbol)
	indicative := book.Indicative(referencePrice)
	trades, updatedOrders, err := book.Uncross(ctx, indicative, func(buy *domain.Order, sell *domain.Order, price, quantity int64) (domain.Trade, error) {
		sequenceNumber, err := e.seq.Next(ctx)
		if err != nil {
			return domain.Trade{}, err
		}
		trade := makeAuctionTrade(sequenceNumber, e.sessionID, symbol, buy, sell, price, quantity)
		if e.summaries != nil {
			e.summaries.ApplyTrade(trade)
		}
		return trade, nil
	})
	if err != nil {
		return indicative, nil, nil, err
	}
	for _, updated := range updatedOrders {
		if existing, ok := e.orders[updated.ID]; ok {
			*existing = *updated
		}
	}
	return indicative, trades, updatedOrders, nil
}

func (e *Engine) Summary(symbol string) (domain.MarketSummary, bool) {
	if e.summaries == nil {
		return domain.MarketSummary{}, false
	}
	return e.summaries.Get(symbol)
}

func (e *Engine) book(symbol string) *Book {
	book, ok := e.books[symbol]
	if !ok {
		book = NewBook(symbol)
		e.books[symbol] = book
	}
	return book
}

func makeTrade(sequenceNumber int64, sessionID string, incoming, resting *domain.Order, price, quantity int64) domain.Trade {
	buy := incoming
	sell := resting
	if incoming.Side == domain.SideSell {
		buy = resting
		sell = incoming
	}
	id := fmt.Sprintf("MATS-T-%d", sequenceNumber)
	return domain.Trade{
		ID:             id,
		SequenceNumber: sequenceNumber,
		SessionID:      sessionID,
		Symbol:         incoming.Symbol,
		Price:          price,
		Quantity:       quantity,
		BuyOrderID:     buy.ID,
		SellOrderID:    sell.ID,
		BuyBrokerCode:  buy.BrokerCode,
		SellBrokerCode: sell.BrokerCode,
		BuyAccountID:   buy.AccountID,
		SellAccountID:  sell.AccountID,
		OccurredAt:     time.Now().UTC(),
		IdempotencyKey: "trade-" + id,
	}
}

func makeAuctionTrade(sequenceNumber int64, sessionID string, symbol string, buy, sell *domain.Order, price, quantity int64) domain.Trade {
	id := fmt.Sprintf("MATS-T-%d", sequenceNumber)
	return domain.Trade{
		ID:             id,
		SequenceNumber: sequenceNumber,
		SessionID:      sessionID,
		Symbol:         symbol,
		Price:          price,
		Quantity:       quantity,
		BuyOrderID:     buy.ID,
		SellOrderID:    sell.ID,
		BuyBrokerCode:  buy.BrokerCode,
		SellBrokerCode: sell.BrokerCode,
		BuyAccountID:   buy.AccountID,
		SellAccountID:  sell.AccountID,
		OccurredAt:     time.Now().UTC(),
		IdempotencyKey: "trade-" + id,
	}
}
