package common

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/Mandala-Exchange/bot-v2/internal/client/bei"
)

func TestSharedDecisionUtilities(t *testing.T) {
	snapshot := bei.Snapshot{
		Session: &bei.SessionState{ID: "session-42"},
		Securities: []bei.Security{
			{Symbol: "MNDL", Status: "listed"},
			{Symbol: "OLD", Status: "delisted"},
		},
		Rules: []bei.TradingRuleProfile{{
			IsDefault:      true,
			TickSizeRules:  json.RawMessage(`[{"min_price":0,"max_price":499,"tick_size":2},{"min_price":500,"max_price":null,"tick_size":5}]`),
			LotSizeRules:   json.RawMessage(`[{"instrument_type":"stock","lot_size":100}]`),
			PriceBandRules: json.RawMessage(`[{"min_reference_price":0,"max_reference_price":null,"ara_percent":0.35,"arb_percent":0.15,"min_price":1}]`),
		}},
	}

	parsed := ParseTradingRules(snapshot)
	if got := NormalizeLimitPrice(321, 320, parsed); got != 320 {
		t.Fatalf("unexpected normalized price: %d", got)
	}
	if symbols := ListedSymbols(snapshot); len(symbols) != 1 || symbols[0] != "MNDL" {
		t.Fatalf("unexpected listed symbols: %#v", symbols)
	}
	if SessionID(snapshot) != "session-42" {
		t.Fatal("session instance ID was not used")
	}
	if AffordableLots(100_000, 320, 100, 5) != 3 {
		t.Fatal("affordable lot calculation is incorrect")
	}
	if id := ClientOrderID("noise-0001", 7); !strings.HasPrefix(id, "bot:noise-0001:") || !strings.HasSuffix(id, ":7") {
		t.Fatalf("unexpected client order ID: %s", id)
	}
}
