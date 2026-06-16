package matching

import (
	"context"
	"math"
	"sort"
	"time"

	"mandala-exchange/mats/internal/domain"
)

func (b *Book) Indicative(referencePrice int64) domain.IndicativePriceVolume {
	candidates := b.auctionCandidates()
	best := domain.IndicativePriceVolume{
		Symbol:         b.Symbol,
		ReferencePrice: referencePrice,
		CalculatedAt:   time.Now().UTC(),
	}
	if len(candidates) == 0 {
		return best
	}
	bestSet := false
	for _, price := range candidates {
		buyVolume := int64(0)
		sellVolume := int64(0)
		for _, order := range b.buys {
			if order.RemainingQuantity > 0 && order.Price >= price {
				buyVolume += order.RemainingQuantity
			}
		}
		for _, order := range b.sells {
			if order.RemainingQuantity > 0 && order.Price <= price {
				sellVolume += order.RemainingQuantity
			}
		}
		matched := minInt64(buyVolume, sellVolume)
		imbalance := absInt64(buyVolume - sellVolume)
		candidate := domain.IndicativePriceVolume{
			Symbol:         b.Symbol,
			Price:          price,
			Volume:         matched,
			Imbalance:      imbalance,
			ReferencePrice: referencePrice,
			CalculatedAt:   best.CalculatedAt,
		}
		if !bestSet || betterIndicative(candidate, best, referencePrice) {
			best = candidate
			bestSet = true
		}
	}
	return best
}

func (b *Book) Uncross(ctx context.Context, indicative domain.IndicativePriceVolume, newTrade func(buy *domain.Order, sell *domain.Order, price, quantity int64) (domain.Trade, error)) ([]domain.Trade, []*domain.Order, error) {
	_ = ctx
	trades := make([]domain.Trade, 0)
	updated := make([]*domain.Order, 0)
	if indicative.Price <= 0 || indicative.Volume <= 0 {
		return trades, updated, nil
	}
	sortBuyOrders(b.buys)
	sortSellOrders(b.sells)
	for len(b.buys) > 0 && len(b.sells) > 0 {
		buy := b.buys[0]
		sell := b.sells[0]
		if buy.Price < indicative.Price || sell.Price > indicative.Price {
			break
		}
		quantity := minInt64(buy.RemainingQuantity, sell.RemainingQuantity)
		trade, err := newTrade(buy, sell, indicative.Price, quantity)
		if err != nil {
			return nil, nil, err
		}
		trades = append(trades, trade)
		now := time.Now().UTC()
		buy.RemainingQuantity -= quantity
		buy.FilledQuantity += quantity
		buy.UpdatedAt = now
		sell.RemainingQuantity -= quantity
		sell.FilledQuantity += quantity
		sell.UpdatedAt = now
		updateAuctionOrderStatus(buy)
		updateAuctionOrderStatus(sell)
		updated = append(updated, buy.Clone(), sell.Clone())
		if buy.RemainingQuantity == 0 {
			b.Remove(buy.ID)
		}
		if sell.RemainingQuantity == 0 {
			b.Remove(sell.ID)
		}
	}
	return trades, updated, nil
}

func (b *Book) auctionCandidates() []int64 {
	seen := make(map[int64]struct{})
	for _, order := range b.buys {
		if order.RemainingQuantity > 0 {
			seen[order.Price] = struct{}{}
		}
	}
	for _, order := range b.sells {
		if order.RemainingQuantity > 0 {
			seen[order.Price] = struct{}{}
		}
	}
	candidates := make([]int64, 0, len(seen))
	for price := range seen {
		candidates = append(candidates, price)
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[i] < candidates[j] })
	return candidates
}

func betterIndicative(candidate, best domain.IndicativePriceVolume, referencePrice int64) bool {
	if candidate.Volume != best.Volume {
		return candidate.Volume > best.Volume
	}
	if candidate.Imbalance != best.Imbalance {
		return candidate.Imbalance < best.Imbalance
	}
	candidateDistance := absInt64(candidate.Price - referencePrice)
	bestDistance := absInt64(best.Price - referencePrice)
	if candidateDistance != bestDistance {
		return candidateDistance < bestDistance
	}
	return candidate.Price < best.Price
}

func updateAuctionOrderStatus(order *domain.Order) {
	if order.RemainingQuantity == 0 {
		order.Status = domain.OrderStatusFilled
		return
	}
	if order.FilledQuantity > 0 {
		order.Status = domain.OrderStatusPartiallyFilled
		return
	}
	order.Status = domain.OrderStatusOpen
}

func absInt64(value int64) int64 {
	if value == math.MinInt64 {
		return math.MaxInt64
	}
	if value < 0 {
		return -value
	}
	return value
}
