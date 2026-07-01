package marketrules

import (
	"errors"
	"testing"
	"time"
)

func TestSnapshotResolverUsesBEIActiveRulesAndExactFee(t *testing.T) {
	securities := []byte(`[{"symbol":"BBCA","status":"listed","board":"main","previous_close":"1000","last":"1010"}]`)
	rules := []byte(`[{
		"board":"main",
		"lot_size_rules":[{"lot_size":100,"effective_date":"2026-01-01"}],
		"tick_size_rules":[{"min_price":"1","max_price":"2000","tick_size":"5"}],
		"price_band_rules":[{"ara_percent":"0.20","arb_percent":"0.20"}]
	}]`)
	fees := []byte(`{
		"brokerBuyRate":"0.0015","brokerSellRate":"0.0025",
		"settlementFeeRate":"0.0001","guaranteeFundRate":"0.0001",
		"vatRate":"0","sellTaxRate":"0.001"
	}`)
	resolver, err := NewSnapshotResolver(securities, rules, fees, time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	order, err := resolver.Resolve("BBCA", "buy", 1303, 250)
	if err != nil {
		t.Fatal(err)
	}
	if order.PriceIDR != 1200 || order.QuantityShares != 200 {
		t.Fatalf("expected BEI band/tick/lot, got %+v", order)
	}
	// 1200*200*(0.0015+0.0001+0.0001) = 408 exactly.
	if order.EstimatedFeeIDR != 408 {
		t.Fatalf("expected exact fee 408, got %d", order.EstimatedFeeIDR)
	}
	if price, ok := resolver.LastPriceIDR("BBCA"); !ok || price != 1010 {
		t.Fatalf("last price not exposed: %d %v", price, ok)
	}
}

func TestSnapshotResolverFailsClosed(t *testing.T) {
	fees := []byte(`{"brokerBuyRate":"0.001","brokerSellRate":"0.001","settlementFeeRate":"0","guaranteeFundRate":"0","sellTaxRate":"0"}`)
	_, err := NewSnapshotResolver(
		[]byte(`[{"symbol":"BBCA","status":"listed","board":"main","previous_close":"1000"}]`),
		[]byte(`[{"board":"main","lot_size_rules":[],"tick_size_rules":[],"price_band_rules":[]}]`),
		fees,
		time.Now(),
	)
	if !errors.Is(err, ErrSnapshotInvalid) {
		t.Fatalf("expected fail-closed invalid snapshot, got %v", err)
	}
}

func TestSnapshotResolverRejectsFutureLotRule(t *testing.T) {
	_, err := NewSnapshotResolver(
		[]byte(`[{"symbol":"BBCA","status":"listed","board":"main","previous_close":"1000"}]`),
		[]byte(`[{"board":"main","lot_size_rules":[{"lot_size":100,"effective_date":"2099-01-01"}],
		"tick_size_rules":[{"min_price":"1","max_price":"2000","tick_size":"5"}],
		"price_band_rules":[{"ara_percent":"0.2","arb_percent":"0.2"}]}]`),
		[]byte(`{"brokerBuyRate":"0.001","brokerSellRate":"0.001","settlementFeeRate":"0","guaranteeFundRate":"0","sellTaxRate":"0"}`),
		time.Now(),
	)
	if err == nil {
		t.Fatal("future lot rule must not become active")
	}
}
