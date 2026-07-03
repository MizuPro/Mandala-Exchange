package marketmaker

import (
	"testing"
	"time"

	"github.com/Mandala-Exchange/BOT/internal/config"
	"github.com/Mandala-Exchange/BOT/internal/marketrules"
)

func newTestResolver(t *testing.T) *marketrules.SnapshotResolver {
	t.Helper()
	securitiesJSON := []byte(`[
		{"symbol":"BBCA","board":"RG","status":"listed","previous_close":10000,"last":10050}
	]`)
	rulesJSON := []byte(`[{
		"board":"RG",
		"lot_size_rules":[{"lot_size":100}],
		"tick_size_rules":[
			{"min_price":1,"max_price":200,"tick_size":1},
			{"min_price":200,"max_price":500,"tick_size":2},
			{"min_price":500,"max_price":2000,"tick_size":5},
			{"min_price":2000,"max_price":5000,"tick_size":10},
			{"min_price":5000,"max_price":9223372036854775807,"tick_size":25}
		],
		"price_band_rules":[{"ara_percent":0.35,"arb_percent":0.35}]
	}]`)
	// round trip rate around 0.30%
	feeJSON := []byte(`{
		"brokerBuyRate":"0.0015","brokerSellRate":"0.0025",
		"settlementFeeRate":"0.0003","guaranteeFundRate":"0.0001",
		"vatRate":"0.11","sellTaxRate":"0.001"
	}`)
	r, err := marketrules.NewSnapshotResolver(securitiesJSON, rulesJSON, feeJSON, time.Now())
	if err != nil {
		t.Fatalf("newTestResolver: %v", err)
	}
	return r
}

func TestGenerateQuotes_Standard(t *testing.T) {
	rules := newTestResolver(t)
	cfg := Config{
		Symbol:                "BBCA",
		Levels:                3,
		SpreadTicks:           config.Distribution{Type: "fixed", Min: 4},
		LevelSizeLots:         config.Distribution{Type: "fixed", Min: 10},
		MaxInventoryLots:      100,
		InventorySkewStrength: 0.50,
		FeeAware:              false,
		SelfTradePrevention:   "cancel_newest",
	}

	currentBids := []BookLevel{
		{Price: 10000, Quantity: 1000},
	}
	currentAsks := []BookLevel{
		{Price: 10050, Quantity: 1000},
	}

	bids, asks, err := GenerateQuotes(
		"BBCA", cfg, currentBids, currentAsks, 10025, 0, rules, 4, 10,
	)
	if err != nil {
		t.Fatalf("GenerateQuotes failed: %v", err)
	}

	if len(bids) != 3 || len(asks) != 3 {
		t.Errorf("expected 3 bids and 3 asks, got %d and %d", len(bids), len(asks))
	}

	// Mid price = (10000 + 10050)/2 = 10025. Snapped: 10025 is valid tick (ended in 25 for tick size 25)
	// Base bid offset = -2 ticks. bid[0] price = 10025 - 2*25 = 9975. Adjusted: 9975
	// Base ask offset = 2 ticks. ask[0] price = 10025 + 2*25 = 10075. Adjusted: 10075
	if bids[0].Price != 9975 {
		t.Errorf("expected best bid price 9975, got %d", bids[0].Price)
	}
	if asks[0].Price != 10075 {
		t.Errorf("expected best ask price 10075, got %d", asks[0].Price)
	}

	// Level quantities should be levelSizeLots * lotSize = 10 * 100 = 1000 shares
	if bids[0].Quantity != 1000 || asks[0].Quantity != 1000 {
		t.Errorf("expected quantity 1000, got bid=%d, ask=%d", bids[0].Quantity, asks[0].Quantity)
	}
}

func TestGenerateQuotes_EmptyBook(t *testing.T) {
	rules := newTestResolver(t)
	cfg := Config{
		Symbol:                "BBCA",
		Levels:                3,
		SpreadTicks:           config.Distribution{Type: "fixed", Min: 4},
		LevelSizeLots:         config.Distribution{Type: "fixed", Min: 10},
		MaxInventoryLots:      100,
		InventorySkewStrength: 0.50,
		FeeAware:              false,
		SelfTradePrevention:   "cancel_newest",
	}

	// Bids and asks empty, fallback to lastPrice = 10000
	bids, asks, err := GenerateQuotes(
		"BBCA", cfg, nil, nil, 10000, 0, rules, 4, 10,
	)
	if err != nil {
		t.Fatalf("GenerateQuotes failed: %v", err)
	}

	// Mid price = 10000.
	// Bid[0] offset = -2 ticks. Price = 10000 - 2*25 = 9950.
	// Ask[0] offset = 2 ticks. Price = 10000 + 2*25 = 10050.
	if bids[0].Price != 9950 {
		t.Errorf("expected best bid price 9950, got %d", bids[0].Price)
	}
	if asks[0].Price != 10050 {
		t.Errorf("expected best ask price 10050, got %d", asks[0].Price)
	}
}

func TestGenerateQuotes_InventorySkew(t *testing.T) {
	rules := newTestResolver(t)
	cfg := Config{
		Symbol:                "BBCA",
		Levels:                1,
		SpreadTicks:           config.Distribution{Type: "fixed", Min: 4},
		LevelSizeLots:         config.Distribution{Type: "fixed", Min: 10},
		MaxInventoryLots:      100,
		InventorySkewStrength: 0.50,
		FeeAware:              false,
		SelfTradePrevention:   "cancel_newest",
	}

	// Mid price = 10000.
	// No inventory: Bid = 9950, Ask = 10050.
	// Positive inventory (inventoryLots = 50, which is half of MaxInventory)
	// inventoryRatio = 0.5
	// shiftTicks = -1.0 * 0.5 * 0.5 * 4 = -1 tick
	// Bid level offset = -2 - 1 = -3 ticks. Bid price = 10000 - 3*25 = 9925
	// Ask level offset = 2 - 1 = 1 tick. Ask price = 10000 + 1*25 = 10025
	bidsPos, asksPos, err := GenerateQuotes(
		"BBCA", cfg, nil, nil, 10000, 50, rules, 4, 10,
	)
	if err != nil {
		t.Fatalf("GenerateQuotes positive inventory failed: %v", err)
	}
	if bidsPos[0].Price != 9925 || asksPos[0].Price != 10025 {
		t.Errorf("expected positive inventory quotes Bid=9925 Ask=10025, got Bid=%d Ask=%d", bidsPos[0].Price, asksPos[0].Price)
	}

	// Negative inventory (inventoryLots = -50)
	// inventoryRatio = -0.5
	// shiftTicks = -1.0 * -0.5 * 0.5 * 4 = +1 tick
	// Bid level offset = -2 + 1 = -1 tick. Bid price = 10000 - 1*25 = 9975
	// Ask level offset = 2 + 1 = 3 ticks. Ask price = 10000 + 3*25 = 10075
	bidsNeg, asksNeg, err := GenerateQuotes(
		"BBCA", cfg, nil, nil, 10000, -50, rules, 4, 10,
	)
	if err != nil {
		t.Fatalf("GenerateQuotes negative inventory failed: %v", err)
	}
	if bidsNeg[0].Price != 9975 || asksNeg[0].Price != 10075 {
		t.Errorf("expected negative inventory quotes Bid=9975 Ask=10075, got Bid=%d Ask=%d", bidsNeg[0].Price, asksNeg[0].Price)
	}
}

func TestGenerateQuotes_FeeAware(t *testing.T) {
	rules := newTestResolver(t)
	cfg := Config{
		Symbol:                "BBCA",
		Levels:                1,
		SpreadTicks:           config.Distribution{Type: "fixed", Min: 1}, // set small spread
		LevelSizeLots:         config.Distribution{Type: "fixed", Min: 10},
		MaxInventoryLots:      100,
		InventorySkewStrength: 0.50,
		FeeAware:              true,
		SelfTradePrevention:   "cancel_newest",
	}

	// Mid price = 10000.
	// Combined fee rates: buy ~0.0015, sell ~0.0025 plus settlement/vat.
	// Total round-trip rate is around 0.005.
	// minSpreadValue = 10000 * 0.005 = 50 IDR.
	// Tick size at 10000 is 25.
	// minSpreadTicks = Ceil(50 / 25) = 2 ticks.
	// Since spreadTicks = 1, it should be overridden to 2.
	bids, asks, err := GenerateQuotes(
		"BBCA", cfg, nil, nil, 10000, 0, rules, 1, 10,
	)
	if err != nil {
		t.Fatalf("GenerateQuotes failed: %v", err)
	}

	// For spreadTicks = 3:
	// bidBaseOffset = -1. askBaseOffset = 2.
	// Bid = 10000 - 25 = 9975. Ask = 10000 + 50 = 10050.
	if bids[0].Price != 9975 || asks[0].Price != 10050 {
		t.Errorf("expected fee-aware adjusted quotes Bid=9975 Ask=10050 (spread=3 ticks), got Bid=%d Ask=%d", bids[0].Price, asks[0].Price)
	}
}

func TestGenerateQuotes_STP(t *testing.T) {
	rules := newTestResolver(t)
	cfg := Config{
		Symbol:                "BBCA",
		Levels:                2,
		SpreadTicks:           config.Distribution{Type: "fixed", Min: 1},
		LevelSizeLots:         config.Distribution{Type: "fixed", Min: 10},
		MaxInventoryLots:      100,
		InventorySkewStrength: 1.0, // strong skew to force crossing
		FeeAware:              false,
		SelfTradePrevention:   "cancel_newest",
	}

	// Let's force an extreme shift (e.g. inventory = 100)
	// inventoryRatio = 1.0
	// shiftTicks = -1.0 * 1.0 * 1.0 * 1 = -1 tick
	// Bid offset = 0 - 1 = -1 tick. Bid price = 10000 - 25 = 9975
	// Ask offset = 1 - 1 = 0 ticks. Ask price = 10000 + 0 = 10000
	// This does not cross.

	// What if we set shift to be -3 ticks manually or construct a scenario where bid >= ask?
	// We can test the STP enforcement directly.
	// If bids[0].Price >= asks[0].Price (due to clamping or low price bounds):
	// Let's test with midPrice = 1 (floor).
	// If midPrice is 1, bids and asks could both be clamped to 1.
	bids, asks, err := GenerateQuotes(
		"BBCA", cfg, nil, nil, 1, 0, rules, 1, 10,
	)
	if err != nil {
		t.Fatalf("GenerateQuotes failed: %v", err)
	}

	// STP should enforce best bid is strictly below best ask for active orders.
	if bids[0].Price >= asks[0].Price {
		if bids[0].Quantity > 0 && asks[0].Quantity > 0 {
			t.Errorf("STP failed: best bid (%d) is not below best ask (%d) for active quotes", bids[0].Price, asks[0].Price)
		}
	}
	// For level 2, it should also be strictly decreasing for active orders.
	if bids[1].Price >= bids[0].Price {
		if bids[1].Quantity > 0 && bids[0].Quantity > 0 {
			t.Errorf("STP failed: bid level 1 (%d) is not below level 0 (%d) for active quotes", bids[1].Price, bids[0].Price)
		}
	}
}

func TestGenerateQuotes_InventoryLimit(t *testing.T) {
	rules := newTestResolver(t)
	cfg := Config{
		Symbol:                "BBCA",
		Levels:                2,
		SpreadTicks:           config.Distribution{Type: "fixed", Min: 4},
		LevelSizeLots:         config.Distribution{Type: "fixed", Min: 10},
		MaxInventoryLots:      100,
		InventorySkewStrength: 0.50,
		FeeAware:              false,
		SelfTradePrevention:   "cancel_newest",
	}

	// Test buy inventory limit:
	// current inventory = 95 lots. max inventory = 100.
	// remaining buy space = 5 lots.
	// level size = 10 lots.
	// Level 1 bid should get 5 lots (500 shares).
	// Level 2 bid should get 0 lots (0 shares).
	bids, _, err := GenerateQuotes(
		"BBCA", cfg, nil, nil, 10000, 95, rules, 4, 10,
	)
	if err != nil {
		t.Fatalf("GenerateQuotes failed: %v", err)
	}

	if bids[0].Quantity != 500 {
		t.Errorf("expected level 1 bid quantity 500 (5 lots), got %d", bids[0].Quantity)
	}
	if bids[1].Quantity != 0 {
		t.Errorf("expected level 2 bid quantity 0 (0 lots), got %d", bids[1].Quantity)
	}

	// Test sell inventory limit:
	// current inventory = -95 lots. max inventory = 100.
	// remaining sell space = 5 lots.
	// Level 1 ask should get 5 lots (500 shares).
	// Level 2 ask should get 0 lots (0 shares).
	_, asks, err := GenerateQuotes(
		"BBCA", cfg, nil, nil, 10000, -95, rules, 4, 10,
	)
	if err != nil {
		t.Fatalf("GenerateQuotes failed: %v", err)
	}

	if asks[0].Quantity != 500 {
		t.Errorf("expected level 1 ask quantity 500 (5 lots), got %d", asks[0].Quantity)
	}
	if asks[1].Quantity != 0 {
		t.Errorf("expected level 2 ask quantity 0 (0 lots), got %d", asks[1].Quantity)
	}
}
