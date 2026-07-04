package rules

import (
	"encoding/json"
	"testing"
)

func TestParseTickSizeRulesAcceptsNumbersAndStrings(t *testing.T) {
	raw := json.RawMessage(`[
		{"min_price":0,"max_price":199,"tick_size":1},
		{"min_price":"200","max_price":"499","tick_size":"2"},
		{"min_price":500,"max_price":null,"tick_size":5}
	]`)

	parsed := ParseTickSizeRules(raw)
	if len(parsed) != 3 {
		t.Fatalf("expected 3 rules, got %d", len(parsed))
	}
	if got := SnapToTickSize(739, parsed); got != 735 {
		t.Fatalf("expected 739 to snap to 735, got %d", got)
	}
	if got := SnapToTickSize(321, parsed); got != 320 {
		t.Fatalf("expected 321 to snap to 320, got %d", got)
	}
}

func TestParsePriceBandRulesAcceptsNumbersAndStrings(t *testing.T) {
	raw := json.RawMessage(`[
		{
			"min_reference_price":0,
			"max_reference_price":"999",
			"ara_percent":0.35,
			"arb_percent":"0.15",
			"min_price":1
		}
	]`)

	parsed := ParsePriceBandRules(raw)
	if len(parsed) != 1 {
		t.Fatalf("expected 1 rule, got %d", len(parsed))
	}
	if got := ClampToPriceBand(2000, 700, parsed); got != 945 {
		t.Fatalf("expected upper band 945, got %d", got)
	}
}
