// Package marketrules provides pure functions for IDX trading rules (BOT_STATE_MACHINES.md).
// It implements Task 3.2: Dynamic Tick, ARA/ARB, Lot, and Fee Helpers.
package marketrules

import (
	"math"
)

// TickRule defines a price range and its corresponding tick size.
type TickRule struct {
	MinPrice int64
	MaxPrice int64
	TickSize int64
}

// BoardRules contains the trading parameters for a specific board/stock.
type BoardRules struct {
	TickRules []TickRule
	ARAPct    float64 // e.g., 0.35 for 35%
	ARBPct    float64 // e.g., 0.35 for 35%
	LotSize   int64   // normally 100
}

// DefaultMainBoardRules returns the standard IDX Main Board tick rules.
func DefaultMainBoardRules() BoardRules {
	return BoardRules{
		TickRules: []TickRule{
			{MinPrice: 1, MaxPrice: 200, TickSize: 1},
			{MinPrice: 202, MaxPrice: 500, TickSize: 2},
			{MinPrice: 505, MaxPrice: 2000, TickSize: 5},
			{MinPrice: 2010, MaxPrice: 5000, TickSize: 10},
			{MinPrice: 5025, MaxPrice: math.MaxInt64, TickSize: 25},
		},
		ARAPct:  0.20, // Example average, IDX has tiered ARA/ARB based on price
		ARBPct:  0.20,
		LotSize: 100,
	}
}

// getTickSize returns the tick size for a given price based on the rules.
func getTickSize(price int64, rules []TickRule) int64 {
	for _, rule := range rules {
		if price >= rule.MinPrice && price <= rule.MaxPrice {
			return rule.TickSize
		}
	}
	// Fallback to 1 if no rule matches
	return 1
}

// GetValidPriceTick rounds the target price to the nearest valid tick.
// If side == "buy", it rounds DOWN (more conservative/cheaper).
// If side == "sell", it rounds UP (more conservative/expensive).
func GetValidPriceTick(targetPrice int64, rules []TickRule, side string) int64 {
	if targetPrice <= 0 {
		return 1 // Absolute floor
	}

	tickSize := getTickSize(targetPrice, rules)
	remainder := targetPrice % tickSize

	if remainder == 0 {
		return targetPrice
	}

	if side == "buy" {
		// Round down
		return targetPrice - remainder
	} else if side == "sell" {
		// Round up
		return targetPrice + (tickSize - remainder)
	}

	// Default to nearest
	if remainder >= tickSize/2 {
		return targetPrice + (tickSize - remainder)
	}
	return targetPrice - remainder
}

// ClampToPriceBand clamps the target price within the ARA (upper) and ARB (lower) limits.
// It also ensures the clamped price lands on a valid tick.
func ClampToPriceBand(targetPrice, previousClose int64, rules BoardRules, side string) int64 {
	if previousClose <= 0 {
		return GetValidPriceTick(targetPrice, rules.TickRules, side)
	}

	// Calculate bounds
	maxPriceF := float64(previousClose) * (1.0 + rules.ARAPct)
	minPriceF := float64(previousClose) * (1.0 - rules.ARBPct)

	maxPrice := int64(maxPriceF)
	minPrice := int64(minPriceF)

	// Round the bounds to valid ticks inward (conservative limits)
	maxPrice = GetValidPriceTick(maxPrice, rules.TickRules, "buy")  // floor upper bound
	minPrice = GetValidPriceTick(minPrice, rules.TickRules, "sell") // ceil lower bound

	if minPrice <= 0 {
		minPrice = 1 // absolute floor
	}

	// Clamp
	clamped := targetPrice
	if clamped > maxPrice {
		clamped = maxPrice
	}
	if clamped < minPrice {
		clamped = minPrice
	}

	return GetValidPriceTick(clamped, rules.TickRules, side)
}

// AlignToLotSize rounds down the quantity of shares to the nearest whole lot.
func AlignToLotSize(qtyShares, lotSize int64) int64 {
	if lotSize <= 0 {
		lotSize = 100 // IDX standard fallback
	}
	if qtyShares < lotSize {
		return 0
	}
	remainder := qtyShares % lotSize
	return qtyShares - remainder
}

// EstimateFee calculates the estimated fee (broker + levy + vat) for an order.
// feeRate is expressed as a decimal (e.g., 0.0015 for 0.15%).
// Returns the fee rounded up to ensure sufficient reservation.
func EstimateFee(priceIDR, qtyShares int64, feeRate float64) int64 {
	gross := float64(priceIDR * qtyShares)
	fee := gross * feeRate
	return int64(math.Ceil(fee))
}
