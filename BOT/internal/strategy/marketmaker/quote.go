package marketmaker

import (
	"errors"
	"fmt"
	"math"
	"math/rand"

	"github.com/Mandala-Exchange/BOT/internal/config"
	"github.com/Mandala-Exchange/BOT/internal/marketrules"
)

// BookLevel represents a price level in the order book.
type BookLevel struct {
	Price    int64 `json:"price"`
	Quantity int64 `json:"quantity"`
}

// Quote represents a generated limit order quote.
type Quote struct {
	Price    int64
	Quantity int64
}

// GenerateQuotes computes the bid and ask quotes for the Market Maker strategy.
// It is a pure math function, which makes it highly testable.
func GenerateQuotes(
	symbol string,
	cfg Config,
	currentBids []BookLevel,
	currentAsks []BookLevel,
	lastPrice int64,
	inventoryLots int64,
	rules *marketrules.SnapshotResolver,
	spreadTicks int,
	levelSizeLots int,
) ([]Quote, []Quote, error) {
	if rules == nil {
		return nil, nil, errors.New("rules snapshot resolver is nil")
	}

	boardRules, ok := rules.SecurityRules(symbol)
	if !ok {
		return nil, nil, fmt.Errorf("security rules not found for symbol: %s", symbol)
	}

	// 1. Calculate Mid Price
	var midPrice int64
	if len(currentBids) > 0 && len(currentAsks) > 0 {
		midPrice = (currentBids[0].Price + currentAsks[0].Price) / 2
	} else {
		midPrice = lastPrice
	}

	if midPrice <= 0 {
		return nil, nil, fmt.Errorf("invalid reference/mid price: %d", midPrice)
	}

	// Snap midPrice to nearest valid tick
	midPriceSnapped := marketrules.GetValidPriceTick(midPrice, boardRules.TickRules, "buy")

	// 2. Fee-Aware Spread Adjustment
	actualSpreadTicks := spreadTicks
	if cfg.FeeAware {
		buyRate, sellRate := getFeeRates(symbol, rules)
		roundTripRate := buyRate + sellRate
		minSpreadValue := float64(midPriceSnapped) * roundTripRate
		tickSize := getTickSize(midPriceSnapped, boardRules.TickRules)
		minSpreadTicks := int(math.Ceil(minSpreadValue / float64(tickSize)))
		if actualSpreadTicks < minSpreadTicks {
			actualSpreadTicks = minSpreadTicks
		}
	}

	// Ensure spread ticks is at least 1
	if actualSpreadTicks < 1 {
		actualSpreadTicks = 1
	}

	// 3. Inventory Skew Shift
	inventoryRatio := float64(inventoryLots) / float64(cfg.MaxInventoryLots)
	// Clamp inventory ratio to [-1.0, 1.0]
	if inventoryRatio < -1.0 {
		inventoryRatio = -1.0
	} else if inventoryRatio > 1.0 {
		inventoryRatio = 1.0
	}

	// Positive inventory -> shift price ticks DOWN (encourage sell, discourage buy)
	// Negative inventory -> shift price ticks UP (encourage buy, discourage sell)
	shiftTicksF := -1.0 * inventoryRatio * cfg.InventorySkewStrength * float64(actualSpreadTicks)
	shiftTicks := int(math.Round(shiftTicksF))

	// 4. Calculate Quote Level Offsets
	// Symmetrical base offsets
	bidBaseOffset := -1 * (actualSpreadTicks / 2)
	askBaseOffset := (actualSpreadTicks + 1) / 2

	bids := make([]Quote, 0, cfg.Levels)
	asks := make([]Quote, 0, cfg.Levels)

	// Keep track of inventory space to enforce limits
	remainingBuySpaceLots := cfg.MaxInventoryLots - inventoryLots
	if remainingBuySpaceLots < 0 {
		remainingBuySpaceLots = 0
	}
	remainingSellSpaceLots := cfg.MaxInventoryLots + inventoryLots
	if remainingSellSpaceLots < 0 {
		remainingSellSpaceLots = 0
	}

	totalBidsLots := int64(0)
	totalAsksLots := int64(0)

	// Generate bids (buy side)
	for i := 0; i < cfg.Levels; i++ {
		offset := bidBaseOffset + shiftTicks - i
		price, err := rules.AdjustPriceTicks(symbol, "buy", midPriceSnapped, offset)
		if err != nil {
			return nil, nil, fmt.Errorf("failed to calculate bid price tick at level %d: %w", i, err)
		}

		qtyLots := int64(levelSizeLots)
		if totalBidsLots+qtyLots > remainingBuySpaceLots {
			qtyLots = remainingBuySpaceLots - totalBidsLots
		}
		if qtyLots < 0 {
			qtyLots = 0
		}

		qtyShares := qtyLots * boardRules.LotSize
		bids = append(bids, Quote{Price: price, Quantity: qtyShares})
		totalBidsLots += qtyLots
	}

	// Generate asks (sell side)
	for i := 0; i < cfg.Levels; i++ {
		offset := askBaseOffset + shiftTicks + i
		price, err := rules.AdjustPriceTicks(symbol, "sell", midPriceSnapped, offset)
		if err != nil {
			return nil, nil, fmt.Errorf("failed to calculate ask price tick at level %d: %w", i, err)
		}

		qtyLots := int64(levelSizeLots)
		if totalAsksLots+qtyLots > remainingSellSpaceLots {
			qtyLots = remainingSellSpaceLots - totalAsksLots
		}
		if qtyLots < 0 {
			qtyLots = 0
		}

		qtyShares := qtyLots * boardRules.LotSize
		asks = append(asks, Quote{Price: price, Quantity: qtyShares})
		totalAsksLots += qtyLots
	}

	// 5. STP (Self-Trade Prevention) Enforcement
	// Best bid (bids[0]) must be at least 1 tick below best ask (asks[0])
	if len(bids) > 0 && len(asks) > 0 {
		bestBidPrice := bids[0].Price
		bestAskPrice := asks[0].Price

		if bestBidPrice >= bestAskPrice {
			// Shift bids down so bids[0] is strictly below asks[0] by at least 1 tick
			adjustedBid, err := rules.AdjustPriceTicks(symbol, "buy", bestAskPrice, -1)
			if err == nil && adjustedBid < bestAskPrice {
				bids[0].Price = adjustedBid
				// Cascading adjustment down the levels to maintain ordering
				for i := 1; i < len(bids); i++ {
					prevBid := bids[i-1].Price
					nextBid, err := rules.AdjustPriceTicks(symbol, "buy", prevBid, -1)
					if err == nil && nextBid < prevBid && bids[i].Price >= prevBid {
						bids[i].Price = nextBid
					} else {
						// If we can't adjust further down due to price band limit, zero out the qty (withdraw)
						bids[i].Quantity = 0
					}
				}
			} else {
				// If we can't even adjust bids[0] below bestAsk, zero out all bids
				for i := range bids {
					bids[i].Quantity = 0
				}
			}
		}
	}

	// Collapsed level collision prevention
	for i := 1; i < len(bids); i++ {
		if bids[i].Price >= bids[i-1].Price {
			bids[i].Quantity = 0
		}
	}
	for i := 1; i < len(asks); i++ {
		if asks[i].Price <= asks[i-1].Price {
			asks[i].Quantity = 0
		}
	}

	return bids, asks, nil
}

// getTickSize returns the tick size for a price based on rules.
func getTickSize(price int64, tickRules []marketrules.TickRule) int64 {
	for _, rule := range tickRules {
		if price >= rule.MinPrice && price <= rule.MaxPrice {
			return rule.TickSize
		}
	}
	return 1
}

// getFeeRates calculates dynamic combined fee rates for BUY and SELL sides from resolver.
func getFeeRates(symbol string, rules *marketrules.SnapshotResolver) (float64, float64) {
	testPrice := int64(10000)
	lotSize, ok := rules.LotSize(symbol)
	if !ok || lotSize <= 0 {
		lotSize = 100
	}
	testQty := int64(1000000 / testPrice)
	testQty = (testQty / lotSize) * lotSize
	if testQty <= 0 {
		testQty = lotSize
	}

	buyOrder, err := rules.Resolve(symbol, "buy", testPrice, testQty)
	var buyRate float64
	if err == nil && buyOrder.PriceIDR > 0 && buyOrder.QuantityShares > 0 {
		buyRate = float64(buyOrder.EstimatedFeeIDR) / float64(buyOrder.PriceIDR*buyOrder.QuantityShares)
	} else {
		buyRate = 0.0015 // Conservative fallback
	}

	sellOrder, err := rules.Resolve(symbol, "sell", testPrice, testQty)
	var sellRate float64
	if err == nil && sellOrder.PriceIDR > 0 && sellOrder.QuantityShares > 0 {
		sellRate = float64(sellOrder.EstimatedFeeIDR) / float64(sellOrder.PriceIDR*sellOrder.QuantityShares)
	} else {
		sellRate = 0.0015 // Conservative fallback
	}

	return buyRate, sellRate
}

// SampleDistribution converts a configured distribution to a float64 sample.
func SampleDistribution(d config.Distribution, rng *rand.Rand) float64 {
	switch d.Type {
	case "fixed":
		return d.Min
	case "uniform":
		return d.Min + rng.Float64()*(d.Max-d.Min)
	case "normal":
		val := rng.NormFloat64()*d.StdDev + d.Mean
		return clamp(val, d.Min, d.Max)
	case "lognormal":
		val := math.Exp(rng.NormFloat64()*d.StdDev + d.Mean)
		return clamp(val, d.Min, d.Max)
	default:
		return d.Min
	}
}

func clamp(value, min, max float64) float64 {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}
