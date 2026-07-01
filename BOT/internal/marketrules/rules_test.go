package marketrules

import (
	"testing"
)

func TestGetValidPriceTick(t *testing.T) {
	rules := DefaultMainBoardRules().TickRules

	tests := []struct {
		name     string
		price    int64
		side     string
		expected int64
	}{
		{"exact match low", 100, "buy", 100},
		{"exact match low sell", 100, "sell", 100},
		{"round down buy", 101, "buy", 101},
		{"round up sell", 101, "sell", 101},
		{"boundary 200", 200, "buy", 200},
		{"boundary 202 exact", 202, "buy", 202},
		{"round down buy tick 2", 203, "buy", 202},
		{"round up sell tick 2", 203, "sell", 204},
		{"boundary 505 tick 5", 507, "buy", 505},
		{"boundary 505 tick 5 sell", 507, "sell", 510},
		{"high price round down", 5030, "buy", 5025},
		{"high price round up", 5030, "sell", 5050},
		{"zero floor", 0, "buy", 1},
		{"negative floor", -50, "sell", 1},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := GetValidPriceTick(tt.price, rules, tt.side)
			if got != tt.expected {
				t.Errorf("GetValidPriceTick(%d, %s) = %d; want %d", tt.price, tt.side, got, tt.expected)
			}
		})
	}
}

func TestClampToPriceBand(t *testing.T) {
	rules := DefaultMainBoardRules() // 20% ARA/ARB

	tests := []struct {
		name        string
		targetPrice int64
		prevClose   int64
		side        string
		expected    int64
	}{
		// prev close 1000
		// ARA: 1000 * 1.2 = 1200. valid tick 5 -> 1200
		// ARB: 1000 * 0.8 = 800. valid tick 5 -> 800
		{"within band", 1050, 1000, "buy", 1050},
		{"exactly upper", 1200, 1000, "sell", 1200},
		{"exactly lower", 800, 1000, "buy", 800},
		{"exceed upper", 1300, 1000, "buy", 1200}, // clamp to 1200
		{"exceed lower", 700, 1000, "sell", 800},  // clamp to 800

		// prev close 135
		// ARA: 135 * 1.2 = 162. tick 1 -> 162
		// ARB: 135 * 0.8 = 108. tick 1 -> 108
		{"small price within", 140, 135, "buy", 140},
		{"small price exceed upper", 170, 135, "buy", 162},
		{"small price exceed lower", 90, 135, "buy", 108},

		// Zero prev close (IPO day or missing data)
		{"zero prev close", 500, 0, "buy", 500},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ClampToPriceBand(tt.targetPrice, tt.prevClose, rules, tt.side)
			if got != tt.expected {
				t.Errorf("ClampToPriceBand(%d, %d, %s) = %d; want %d", tt.targetPrice, tt.prevClose, tt.side, got, tt.expected)
			}
		})
	}
}

func TestAlignToLotSize(t *testing.T) {
	tests := []struct {
		name     string
		qty      int64
		lotSize  int64
		expected int64
	}{
		{"exact lots", 300, 100, 300},
		{"fractional lot", 350, 100, 300},
		{"less than one lot", 99, 100, 0},
		{"zero qty", 0, 100, 0},
		{"negative lot fallback", 150, -1, 100},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := AlignToLotSize(tt.qty, tt.lotSize)
			if got != tt.expected {
				t.Errorf("AlignToLotSize(%d, %d) = %d; want %d", tt.qty, tt.lotSize, got, tt.expected)
			}
		})
	}
}

func TestEstimateFee(t *testing.T) {
	// gross: 1000 * 100 = 100,000
	// fee: 100,000 * 0.0015 = 150
	got := EstimateFee(1000, 100, 0.0015)
	if got != 150 {
		t.Errorf("EstimateFee() = %d; want 150", got)
	}

	// fractional fee round up
	// gross: 135 * 100 = 13,500
	// fee: 13,500 * 0.0015 = 20.25 -> ceil -> 21
	got2 := EstimateFee(135, 100, 0.0015)
	if got2 != 21 {
		t.Errorf("EstimateFee() = %d; want 21", got2)
	}
}
