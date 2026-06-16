package matching

import (
	"sort"
	"time"

	"mandala-exchange/mats/internal/domain"
)

type Book struct {
	Symbol string
	buys   []*domain.Order
	sells  []*domain.Order
}

func NewBook(symbol string) *Book {
	return &Book{Symbol: symbol}
}

func (b *Book) Add(order *domain.Order) {
	if order.Side == domain.SideBuy {
		b.buys = append(b.buys, order)
		sortBuyOrders(b.buys)
		return
	}
	b.sells = append(b.sells, order)
	sortSellOrders(b.sells)
}

func (b *Book) Remove(orderID string) (*domain.Order, bool) {
	for i, order := range b.buys {
		if order.ID == orderID {
			b.buys = append(b.buys[:i], b.buys[i+1:]...)
			return order, true
		}
	}
	for i, order := range b.sells {
		if order.ID == orderID {
			b.sells = append(b.sells[:i], b.sells[i+1:]...)
			return order, true
		}
	}
	return nil, false
}

func (b *Book) Match(incoming *domain.Order, newTrade func(resting *domain.Order, price, quantity int64) (domain.Trade, error)) ([]domain.Trade, []*domain.Order, error) {
	trades := make([]domain.Trade, 0)
	updatedResting := make([]*domain.Order, 0)

	for incoming.RemainingQuantity > 0 {
		resting := b.bestOpposite(incoming.Side)
		if resting == nil || !crosses(incoming, resting) {
			break
		}

		quantity := minInt64(incoming.RemainingQuantity, resting.RemainingQuantity)
		trade, err := newTrade(resting, resting.Price, quantity)
		if err != nil {
			return nil, nil, err
		}
		trades = append(trades, trade)

		incoming.RemainingQuantity -= quantity
		incoming.FilledQuantity += quantity
		resting.RemainingQuantity -= quantity
		resting.FilledQuantity += quantity
		now := time.Now().UTC()
		incoming.UpdatedAt = now
		resting.UpdatedAt = now

		if resting.RemainingQuantity == 0 {
			resting.Status = domain.OrderStatusFilled
			b.Remove(resting.ID)
		} else {
			resting.Status = domain.OrderStatusPartiallyFilled
		}
		updatedResting = append(updatedResting, resting.Clone())
	}

	switch {
	case incoming.RemainingQuantity == 0:
		incoming.Status = domain.OrderStatusFilled
	case incoming.FilledQuantity > 0:
		incoming.Status = domain.OrderStatusPartiallyFilled
		b.Add(incoming)
	default:
		incoming.Status = domain.OrderStatusOpen
		b.Add(incoming)
	}

	return trades, updatedResting, nil
}

func (b *Book) Snapshot() domain.BookSnapshot {
	return domain.BookSnapshot{
		Symbol: b.Symbol,
		Bids:   aggregateLevels(b.buys),
		Asks:   aggregateLevels(b.sells),
	}
}

func (b *Book) bestOpposite(side domain.Side) *domain.Order {
	if side == domain.SideBuy {
		if len(b.sells) == 0 {
			return nil
		}
		return b.sells[0]
	}
	if len(b.buys) == 0 {
		return nil
	}
	return b.buys[0]
}

func crosses(incoming, resting *domain.Order) bool {
	if incoming.Side == domain.SideBuy {
		return incoming.Price >= resting.Price
	}
	return incoming.Price <= resting.Price
}

func sortBuyOrders(orders []*domain.Order) {
	sort.SliceStable(orders, func(i, j int) bool {
		if orders[i].Price != orders[j].Price {
			return orders[i].Price > orders[j].Price
		}
		return orders[i].SequenceNumber < orders[j].SequenceNumber
	})
}

func sortSellOrders(orders []*domain.Order) {
	sort.SliceStable(orders, func(i, j int) bool {
		if orders[i].Price != orders[j].Price {
			return orders[i].Price < orders[j].Price
		}
		return orders[i].SequenceNumber < orders[j].SequenceNumber
	})
}

func aggregateLevels(orders []*domain.Order) []domain.BookLevel {
	levels := make([]domain.BookLevel, 0)
	for _, order := range orders {
		if order.RemainingQuantity <= 0 {
			continue
		}
		if len(levels) == 0 || levels[len(levels)-1].Price != order.Price {
			levels = append(levels, domain.BookLevel{Price: order.Price})
		}
		level := &levels[len(levels)-1]
		level.Quantity += order.RemainingQuantity
		level.Orders++
	}
	return levels
}

func minInt64(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}
