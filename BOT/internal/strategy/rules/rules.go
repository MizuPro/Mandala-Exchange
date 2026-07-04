// Package rules menyediakan helper function untuk mematuhi aturan perdagangan
// yang dikirim oleh BEI melalui endpoint /bot/trading-rules.
//
// Format JSON dari BEI (dikonfirmasi dari schema.ts & seed.ts):
//   - lot_size_rules: array, field "lot_size" adalah integer
//   - tick_size_rules: array tiered, field numeric ("min_price","max_price","tick_size") dikirim sebagai STRING
//   - price_band_rules: array tiered, field numeric dikirim sebagai STRING, "max_*" bisa null
//   - auto_rejection_rules: array, "max_lots_per_order" integer, "max_listed_shares_percent" string decimal
package rules

import (
	"bytes"
	"encoding/json"
	"strconv"

	"github.com/Mandala-Exchange/bot-v2/internal/logger"
)

type numericValue float64

func (n *numericValue) UnmarshalJSON(data []byte) error {
	data = bytes.TrimSpace(data)
	if len(data) == 0 || bytes.Equal(data, []byte("null")) {
		return nil
	}
	if data[0] == '"' {
		var text string
		if err := json.Unmarshal(data, &text); err != nil {
			return err
		}
		value, err := strconv.ParseFloat(text, 64)
		if err != nil {
			return err
		}
		*n = numericValue(value)
		return nil
	}
	value, err := strconv.ParseFloat(string(data), 64)
	if err != nil {
		return err
	}
	*n = numericValue(value)
	return nil
}

// --------------------------------------------------------------------------
// Struct definitions (reflect actual DB columns sent via json_agg)
// --------------------------------------------------------------------------

// rawTickSizeRule memetakan kolom DB — nilai numeric dikirim sebagai string oleh Postgres.
type rawTickSizeRule struct {
	ID        string        `json:"id"`
	ProfileID string        `json:"profile_id"`
	MinPrice  numericValue  `json:"min_price"`
	MaxPrice  *numericValue `json:"max_price"`
	TickSize  numericValue  `json:"tick_size"`
}

// rawLotSizeRule memetakan kolom DB.
type rawLotSizeRule struct {
	ID             string      `json:"id"`
	ProfileID      string      `json:"profile_id"`
	InstrumentType string      `json:"instrument_type"`
	LotSize        int64       `json:"lot_size"` // integer, tidak perlu parse
	EffectiveDate  string      `json:"effective_date"`
	CreatedAt      interface{} `json:"created_at"`
	UpdatedAt      interface{} `json:"updated_at"`
}

// rawPriceBandRule memetakan kolom DB.
type rawPriceBandRule struct {
	ID                string        `json:"id"`
	ProfileID         string        `json:"profile_id"`
	MinReferencePrice numericValue  `json:"min_reference_price"`
	MaxReferencePrice *numericValue `json:"max_reference_price"`
	ARAPercent        numericValue  `json:"ara_percent"`
	ARBPercent        numericValue  `json:"arb_percent"`
	MinPrice          numericValue  `json:"min_price"`
}

// rawAutoRejectionRule memetakan kolom DB.
type rawAutoRejectionRule struct {
	ID                     string      `json:"id"`
	ProfileID              string      `json:"profile_id"`
	MaxLotsPerOrder        int64       `json:"max_lots_per_order"`        // integer
	MaxListedSharesPercent interface{} `json:"max_listed_shares_percent"` // bisa null
	CreatedAt              interface{} `json:"created_at"`
	UpdatedAt              interface{} `json:"updated_at"`
}

// --------------------------------------------------------------------------
// Parsed structs — dipakai oleh strategy logic
// --------------------------------------------------------------------------

// TickSizeRule adalah hasil parse dari raw tick_size_rules.
type TickSizeRule struct {
	MinPrice float64
	MaxPrice *float64 // nil = tidak ada batas atas
	TickSize float64
}

// LotSizeRule adalah hasil parse dari raw lot_size_rules.
type LotSizeRule struct {
	InstrumentType string
	LotSize        int64
}

// PriceBandRule adalah hasil parse dari raw price_band_rules.
type PriceBandRule struct {
	MinReferencePrice float64
	MaxReferencePrice *float64 // nil = tidak ada batas atas
	ARAPercent        float64  // 0.35 = 35% batas atas
	ARBPercent        float64  // 0.15 = 15% batas bawah
	MinPrice          float64
}

// AutoRejectionRule adalah hasil parse dari raw auto_rejection_rules.
type AutoRejectionRule struct {
	MaxLotsPerOrder        int64
	MaxListedSharesPercent *float64 // nil = tidak ada batas
}

// --------------------------------------------------------------------------
// Parse functions
// --------------------------------------------------------------------------

// ParseTickSizeRules mem-parse json.RawMessage dari BEI menjadi slice TickSizeRule.
func ParseTickSizeRules(raw json.RawMessage) []TickSizeRule {
	var raws []rawTickSizeRule
	if err := json.Unmarshal(raw, &raws); err != nil {
		logger.Warn("Failed to parse tick_size_rules", "error", err.Error())
		return nil
	}

	out := make([]TickSizeRule, 0, len(raws))
	for _, r := range raws {
		minPrice := float64(r.MinPrice)
		tickSize := float64(r.TickSize)
		if tickSize <= 0 {
			logger.Warn("Invalid tick_size in tick_size_rule", "value", tickSize)
			continue
		}

		rule := TickSizeRule{
			MinPrice: minPrice,
			TickSize: tickSize,
		}

		// max_price bisa null — interface{} akan berupa nil kalau null dari JSON
		if r.MaxPrice != nil {
			value := float64(*r.MaxPrice)
			rule.MaxPrice = &value
		}

		out = append(out, rule)
	}
	return out
}

// ParseLotSizeRules mem-parse json.RawMessage dari BEI menjadi slice LotSizeRule.
func ParseLotSizeRules(raw json.RawMessage) []LotSizeRule {
	var raws []rawLotSizeRule
	if err := json.Unmarshal(raw, &raws); err != nil {
		logger.Warn("Failed to parse lot_size_rules", "error", err.Error())
		return nil
	}

	out := make([]LotSizeRule, 0, len(raws))
	for _, r := range raws {
		out = append(out, LotSizeRule{
			InstrumentType: r.InstrumentType,
			LotSize:        r.LotSize,
		})
	}
	return out
}

// ParsePriceBandRules mem-parse json.RawMessage dari BEI menjadi slice PriceBandRule.
func ParsePriceBandRules(raw json.RawMessage) []PriceBandRule {
	var raws []rawPriceBandRule
	if err := json.Unmarshal(raw, &raws); err != nil {
		logger.Warn("Failed to parse price_band_rules", "error", err.Error())
		return nil
	}

	out := make([]PriceBandRule, 0, len(raws))
	for _, r := range raws {
		minRef := float64(r.MinReferencePrice)
		ara := float64(r.ARAPercent)
		arb := float64(r.ARBPercent)
		minP := float64(r.MinPrice)
		if minP <= 0 {
			minP = 1
		}

		rule := PriceBandRule{
			MinReferencePrice: minRef,
			ARAPercent:        ara,
			ARBPercent:        arb,
			MinPrice:          minP,
		}

		if r.MaxReferencePrice != nil {
			value := float64(*r.MaxReferencePrice)
			rule.MaxReferencePrice = &value
		}

		out = append(out, rule)
	}
	return out
}

// ParseAutoRejectionRules mem-parse json.RawMessage dari BEI.
func ParseAutoRejectionRules(raw json.RawMessage) []AutoRejectionRule {
	var raws []rawAutoRejectionRule
	if err := json.Unmarshal(raw, &raws); err != nil {
		logger.Warn("Failed to parse auto_rejection_rules", "error", err.Error())
		return nil
	}

	out := make([]AutoRejectionRule, 0, len(raws))
	for _, r := range raws {
		rule := AutoRejectionRule{
			MaxLotsPerOrder: r.MaxLotsPerOrder,
		}
		if r.MaxListedSharesPercent != nil {
			if s, ok := r.MaxListedSharesPercent.(string); ok && s != "" {
				if v, err := strconv.ParseFloat(s, 64); err == nil {
					rule.MaxListedSharesPercent = &v
				}
			}
		}
		out = append(out, rule)
	}
	return out
}

// --------------------------------------------------------------------------
// Trading rule utilities
// --------------------------------------------------------------------------

// GetDefaultLotSize mengembalikan lot size default (biasanya 100 lembar per lot).
// Jika rules kosong, fallback ke 100.
func GetDefaultLotSize(rules []LotSizeRule) int64 {
	for _, r := range rules {
		if r.InstrumentType == "stock" {
			return r.LotSize
		}
	}
	if len(rules) > 0 {
		return rules[0].LotSize
	}
	return 100 // BEI default
}

// SnapToTickSize membulatkan price ke bawah (floor) ke kelipatan tick size yang sesuai
// berdasarkan tier yang berlaku untuk price tersebut.
//
// Contoh: price=317, tick rule berlaku tick_size=2 → 316
// Jika tidak ada aturan yang cocok, kembalikan price tanpa perubahan.
func SnapToTickSize(price int64, rules []TickSizeRule) int64 {
	if price <= 0 {
		return 0
	}
	priceF := float64(price)
	for _, r := range rules {
		if priceF < r.MinPrice {
			continue
		}
		if r.MaxPrice != nil && priceF > *r.MaxPrice {
			continue
		}
		// Tier cocok — floor ke kelipatan tick_size
		tick := int64(r.TickSize)
		if tick <= 0 {
			tick = 1
		}
		return (price / tick) * tick
	}
	// Tidak ada tier yang cocok — kembalikan price apa adanya
	return price
}

// ClampToPriceBand memastikan proposedPrice tidak melampaui batas ARA/ARB
// berdasarkan referencePrice (biasanya harga terakhir / close session sebelumnya).
//
// ARA = Auto Rejection Above  → harga max = referencePrice * (1 + ara_percent)
// ARB = Auto Rejection Below  → harga min = max(referencePrice * (1 - arb_percent), min_price)
//
// Jika tidak ada rule yang cocok, kembalikan proposedPrice apa adanya.
func ClampToPriceBand(proposedPrice, referencePrice int64, rules []PriceBandRule) int64 {
	if referencePrice <= 0 || proposedPrice <= 0 {
		return proposedPrice
	}
	refF := float64(referencePrice)
	for _, r := range rules {
		if refF < r.MinReferencePrice {
			continue
		}
		if r.MaxReferencePrice != nil && refF > *r.MaxReferencePrice {
			continue
		}
		// Tier cocok
		upperBound := int64(refF * (1.0 + r.ARAPercent))
		lowerBound := int64(refF * (1.0 - r.ARBPercent))
		minPriceFloor := int64(r.MinPrice)
		if lowerBound < minPriceFloor {
			lowerBound = minPriceFloor
		}

		clamped := proposedPrice
		if clamped > upperBound {
			clamped = upperBound
		}
		if clamped < lowerBound {
			clamped = lowerBound
		}
		return clamped
	}
	return proposedPrice
}

// GetMaxLotsPerOrder mengembalikan batas maksimal lot per order dari auto_rejection_rules.
// Fallback ke 50000 (BEI default) jika kosong.
func GetMaxLotsPerOrder(rules []AutoRejectionRule) int64 {
	if len(rules) > 0 {
		return rules[0].MaxLotsPerOrder
	}
	return 50000
}
