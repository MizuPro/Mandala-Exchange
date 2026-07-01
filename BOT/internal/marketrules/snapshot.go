package marketrules

import (
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"strconv"
	"strings"
	"time"
)

var (
	ErrSnapshotInvalid = errors.New("invalid BEI rule snapshot")
	ErrRuleNotFound    = errors.New("active rule not found")
)

type SecurityRule struct {
	Symbol        string
	PreviousClose int64
	LastPrice     int64
	Rules         BoardRules
}

type FeeSchedule struct {
	BuyRate  *big.Rat
	SellRate *big.Rat
}

type SnapshotResolver struct {
	securities map[string]SecurityRule
	fees       FeeSchedule
	version    string
}

type ResolvedOrder struct {
	PriceIDR        int64
	QuantityShares  int64
	EstimatedFeeIDR int64
	RuleVersion     string
}

// NewSnapshotResolver compiles the exact BEI securities/rules/fee snapshots.
// Missing or malformed active data is an error; production must fail closed.
func NewSnapshotResolver(securitiesJSON, rulesJSON, feeJSON []byte, fetchedAt time.Time) (*SnapshotResolver, error) {
	var securities []map[string]any
	var profiles []map[string]any
	var fee map[string]any
	if err := decodeNumbers(securitiesJSON, &securities); err != nil {
		return nil, fmt.Errorf("%w: securities: %v", ErrSnapshotInvalid, err)
	}
	if err := decodeNumbers(rulesJSON, &profiles); err != nil {
		return nil, fmt.Errorf("%w: rules: %v", ErrSnapshotInvalid, err)
	}
	if err := decodeNumbers(feeJSON, &fee); err != nil {
		return nil, fmt.Errorf("%w: fees: %v", ErrSnapshotInvalid, err)
	}
	profileByBoard := make(map[string]BoardRules)
	for _, profile := range profiles {
		board := stringValue(profile, "board")
		if board == "" {
			continue
		}
		compiled, err := compileBoardRules(profile, fetchedAt)
		if err != nil {
			return nil, fmt.Errorf("%w: board %s: %v", ErrSnapshotInvalid, board, err)
		}
		profileByBoard[board] = compiled
	}
	out := &SnapshotResolver{securities: make(map[string]SecurityRule), version: fetchedAt.UTC().Format(time.RFC3339Nano)}
	for _, security := range securities {
		if stringValue(security, "status") != "listed" {
			continue
		}
		symbol := strings.ToUpper(stringValue(security, "symbol"))
		board := stringValue(security, "board")
		rules, ok := profileByBoard[board]
		if symbol == "" || !ok {
			return nil, fmt.Errorf("%w: symbol=%s board=%s", ErrRuleNotFound, symbol, board)
		}
		previous, err := integerValue(security, "previous_close", "previousClose", "reference_price", "referencePrice")
		if err != nil || previous <= 0 {
			return nil, fmt.Errorf("%w: previous close for %s", ErrRuleNotFound, symbol)
		}
		last, _ := integerValue(security, "last")
		if last <= 0 {
			last = previous
		}
		out.securities[symbol] = SecurityRule{Symbol: symbol, PreviousClose: previous, LastPrice: last, Rules: rules}
	}
	if len(out.securities) == 0 {
		return nil, fmt.Errorf("%w: no listed securities", ErrRuleNotFound)
	}
	buy, err := combinedFeeRate(fee, "BUY")
	if err != nil {
		return nil, err
	}
	sell, err := combinedFeeRate(fee, "SELL")
	if err != nil {
		return nil, err
	}
	out.fees = FeeSchedule{BuyRate: buy, SellRate: sell}
	return out, nil
}

func (r *SnapshotResolver) Resolve(symbol, side string, targetPrice, quantityShares int64) (ResolvedOrder, error) {
	security, ok := r.securities[strings.ToUpper(symbol)]
	if !ok || (side != "buy" && side != "sell") || targetPrice <= 0 || quantityShares <= 0 {
		return ResolvedOrder{}, ErrRuleNotFound
	}
	price := ClampToPriceBand(targetPrice, security.PreviousClose, security.Rules, side)
	qty := AlignToLotSize(quantityShares, security.Rules.LotSize)
	if qty <= 0 {
		return ResolvedOrder{}, fmt.Errorf("%w: quantity below active lot", ErrRuleNotFound)
	}
	rate := r.fees.BuyRate
	if side == "sell" {
		rate = r.fees.SellRate
	}
	fee, err := estimateFeeExact(price, qty, rate)
	if err != nil {
		return ResolvedOrder{}, err
	}
	return ResolvedOrder{PriceIDR: price, QuantityShares: qty, EstimatedFeeIDR: fee, RuleVersion: r.version}, nil
}

func (r *SnapshotResolver) LastPriceIDR(symbol string) (int64, bool) {
	s, ok := r.securities[strings.ToUpper(symbol)]
	return s.LastPrice, ok && s.LastPrice > 0
}

func (r *SnapshotResolver) LotSize(symbol string) (int64, bool) {
	s, ok := r.securities[strings.ToUpper(symbol)]
	return s.Rules.LotSize, ok && s.Rules.LotSize > 0
}

// AdjustPriceTicks moves a proposed price by a bounded number of active ticks,
// then clamps it to the authoritative price band. Tick size is re-evaluated
// after every step so tier boundaries remain valid.
func (r *SnapshotResolver) AdjustPriceTicks(symbol, side string, price int64, offset int) (int64, error) {
	security, ok := r.securities[strings.ToUpper(symbol)]
	if !ok || (side != "buy" && side != "sell") || price <= 0 {
		return 0, ErrRuleNotFound
	}
	adjusted := ClampToPriceBand(price, security.PreviousClose, security.Rules, side)
	direction := 1
	if offset < 0 {
		direction = -1
		offset = -offset
	}
	for i := 0; i < offset; i++ {
		tick := getTickSize(adjusted, security.Rules.TickRules)
		if direction < 0 {
			// A downward move crossing a tier must use the lower tier's tick.
			tick = getTickSize(maxInt64(1, adjusted-1), security.Rules.TickRules)
		}
		adjusted += int64(direction) * tick
		adjusted = ClampToPriceBand(adjusted, security.PreviousClose, security.Rules, side)
	}
	return adjusted, nil
}

func maxInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

func compileBoardRules(profile map[string]any, asOf time.Time) (BoardRules, error) {
	var lot int64
	for _, rule := range objectSlice(profile["lot_size_rules"]) {
		effective := stringValue(rule, "effective_date", "effectiveDate")
		if effective != "" {
			date, err := time.Parse("2006-01-02", effective)
			if err != nil || date.After(asOf) {
				continue
			}
		}
		value, err := integerValue(rule, "lot_size", "lotSize")
		if err == nil && value > 0 {
			lot = value
		}
	}
	var ticks []TickRule
	for _, rule := range objectSlice(profile["tick_size_rules"]) {
		min, err := integerValue(rule, "min_price", "minPrice")
		if err != nil {
			return BoardRules{}, err
		}
		max, err := integerValue(rule, "max_price", "maxPrice")
		if err != nil {
			max = int64(^uint64(0) >> 1)
		}
		tick, err := integerValue(rule, "tick_size", "tickSize")
		if err != nil || tick <= 0 {
			return BoardRules{}, errors.New("invalid tick size")
		}
		ticks = append(ticks, TickRule{MinPrice: min, MaxPrice: max, TickSize: tick})
	}
	bands := objectSlice(profile["price_band_rules"])
	if lot <= 0 || len(ticks) == 0 || len(bands) == 0 {
		return BoardRules{}, errors.New("lot/tick/price-band rule missing")
	}
	ara, err := decimalFloat(bands[0], "ara_percent", "araPercent")
	if err != nil {
		return BoardRules{}, err
	}
	arb, err := decimalFloat(bands[0], "arb_percent", "arbPercent")
	if err != nil {
		return BoardRules{}, err
	}
	return BoardRules{TickRules: ticks, ARAPct: ara, ARBPct: arb, LotSize: lot}, nil
}

func combinedFeeRate(fee map[string]any, side string) (*big.Rat, error) {
	brokerKeys := []string{"brokerBuyRate", "broker_buy_rate"}
	if side == "BUY" {
		brokerKeys = []string{"brokerBuyRate", "broker_buy_rate"}
	} else {
		brokerKeys = []string{"brokerSellRate", "broker_sell_rate"}
	}
	broker, err := firstRate(fee, brokerKeys...)
	if err != nil {
		return nil, err
	}
	settlement, err := firstRate(fee, "settlementFeeRate", "settlement_fee_rate")
	if err != nil {
		return nil, err
	}
	guarantee, err := firstRate(fee, "guaranteeFundRate", "guarantee_fund_rate")
	if err != nil {
		return nil, err
	}
	vat, err := firstRate(fee, "vatRate", "vat_rate")
	if err != nil {
		vat = new(big.Rat)
	}
	total := new(big.Rat).Add(broker, settlement)
	total.Add(total, guarantee)
	total.Add(total, new(big.Rat).Mul(broker, vat))
	if side == "SELL" {
		sellTax, taxErr := firstRate(fee, "sellTaxRate", "sell_tax_rate")
		if taxErr != nil {
			return nil, taxErr
		}
		total.Add(total, sellTax)
	}
	return total, nil
}

func firstRate(values map[string]any, keys ...string) (*big.Rat, error) {
	for _, key := range keys {
		if value, ok := values[key]; ok && value != nil {
			rate, err := decimalRat(value)
			if err != nil {
				return nil, fmt.Errorf("%w: fee %s", ErrSnapshotInvalid, key)
			}
			return rate, nil
		}
	}
	return nil, fmt.Errorf("%w: fee rate missing (%s)", ErrRuleNotFound, strings.Join(keys, "/"))
}

func estimateFeeExact(price, quantity int64, rate *big.Rat) (int64, error) {
	gross := new(big.Int).Mul(big.NewInt(price), big.NewInt(quantity))
	value := new(big.Rat).Mul(new(big.Rat).SetInt(gross), rate)
	q := new(big.Int).Quo(value.Num(), value.Denom())
	if new(big.Int).Mod(value.Num(), value.Denom()).Sign() != 0 {
		q.Add(q, big.NewInt(1))
	}
	if !q.IsInt64() {
		return 0, fmt.Errorf("%w: fee overflow", ErrSnapshotInvalid)
	}
	return q.Int64(), nil
}

func decodeNumbers(data []byte, out any) error {
	d := json.NewDecoder(strings.NewReader(string(data)))
	d.UseNumber()
	return d.Decode(out)
}
func objectSlice(v any) []map[string]any {
	items, _ := v.([]any)
	out := make([]map[string]any, 0, len(items))
	for _, item := range items {
		if m, ok := item.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}
func stringValue(m map[string]any, keys ...string) string {
	for _, key := range keys {
		if v, ok := m[key]; ok && v != nil {
			return fmt.Sprint(v)
		}
	}
	return ""
}
func integerValue(m map[string]any, keys ...string) (int64, error) {
	for _, key := range keys {
		if v, ok := m[key]; ok && v != nil {
			r, err := decimalRat(v)
			if err != nil || !r.IsInt() || !r.Num().IsInt64() {
				return 0, errors.New("not an integer")
			}
			return r.Num().Int64(), nil
		}
	}
	return 0, errors.New("missing integer")
}
func decimalRat(v any) (*big.Rat, error) {
	s := fmt.Sprint(v)
	r, ok := new(big.Rat).SetString(s)
	if !ok {
		return nil, errors.New("invalid decimal")
	}
	return r, nil
}
func decimalFloat(m map[string]any, keys ...string) (float64, error) {
	for _, key := range keys {
		if v, ok := m[key]; ok {
			return strconv.ParseFloat(fmt.Sprint(v), 64)
		}
	}
	return 0, errors.New("missing decimal")
}
