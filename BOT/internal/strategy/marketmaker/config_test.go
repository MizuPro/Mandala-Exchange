package marketmaker

import (
	"testing"

	"github.com/Mandala-Exchange/BOT/internal/config"
)

func TestParseConfig(t *testing.T) {
	// Should fallback to default config
	cfg, err := ParseConfig(map[string]interface{}{})
	if err != nil {
		t.Fatalf("unexpected error parsing empty config: %v", err)
	}

	if cfg.Symbol != "" {
		t.Errorf("expected empty symbol, got %s", cfg.Symbol)
	}
	if cfg.SymbolsUniverse.Type != "all_active" {
		t.Errorf("expected default symbols universe type all_active, got %s", cfg.SymbolsUniverse.Type)
	}
	if cfg.Levels != 3 {
		t.Errorf("expected default levels 3, got %d", cfg.Levels)
	}
	if cfg.InventorySkewStrength != 0.50 {
		t.Errorf("expected default skew strength 0.50, got %f", cfg.InventorySkewStrength)
	}
}

func TestValidateConfig(t *testing.T) {
	valid := Config{
		Symbol:                "BBCA",
		Levels:                3,
		SpreadTicks:           config.Distribution{Type: "uniform", Min: 2, Max: 6},
		LevelSizeLots:         config.Distribution{Type: "uniform", Min: 5, Max: 25},
		RefreshVirtualSeconds: config.Distribution{Type: "uniform", Min: 20, Max: 45},
		MaxInventoryLots:      100,
		InventorySkewStrength: 0.50,
		SelfTradePrevention:   "cancel_newest",
	}

	if err := ValidateConfig(valid); err != nil {
		t.Errorf("expected valid config, got: %v", err)
	}

	// Test empty symbol and empty symbols universe
	invalidSym := valid
	invalidSym.Symbol = ""
	invalidSym.SymbolsUniverse.Type = ""
	if err := ValidateConfig(invalidSym); err == nil {
		t.Errorf("expected error for empty symbol and empty symbols universe")
	}

	// Test valid when only SymbolsUniverse is provided
	validDyn := invalidSym
	validDyn.SymbolsUniverse.Type = "all_active"
	if err := ValidateConfig(validDyn); err != nil {
		t.Errorf("expected no error when symbol is empty but symbols universe is provided, got: %v", err)
	}

	// Test levels <= 0
	invalidLevels := valid
	invalidLevels.Levels = 0
	if err := ValidateConfig(invalidLevels); err == nil {
		t.Errorf("expected error for levels <= 0")
	}

	// Test invalid distribution type
	invalidDist := valid
	invalidDist.SpreadTicks = config.Distribution{Type: "invalid"}
	if err := ValidateConfig(invalidDist); err == nil {
		t.Errorf("expected error for invalid distribution type")
	}

	// Test max inventory <= 0
	invalidInv := valid
	invalidInv.MaxInventoryLots = 0
	if err := ValidateConfig(invalidInv); err == nil {
		t.Errorf("expected error for max inventory lots <= 0")
	}

	// Test inventory skew strength out of bounds
	invalidSkewLow := valid
	invalidSkewLow.InventorySkewStrength = -0.1
	if err := ValidateConfig(invalidSkewLow); err == nil {
		t.Errorf("expected error for skew < 0")
	}

	invalidSkewHigh := valid
	invalidSkewHigh.InventorySkewStrength = 1.1
	if err := ValidateConfig(invalidSkewHigh); err == nil {
		t.Errorf("expected error for skew > 1")
	}

	// Test unsupported self trade prevention
	invalidSTP := valid
	invalidSTP.SelfTradePrevention = "cancel_random"
	if err := ValidateConfig(invalidSTP); err == nil {
		t.Errorf("expected error for invalid self trade prevention value")
	}
}
