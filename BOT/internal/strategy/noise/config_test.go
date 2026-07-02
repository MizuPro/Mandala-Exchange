package noise

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

	if cfg.BuyProbability != 0.50 {
		t.Errorf("expected buy probability 0.50, got %f", cfg.BuyProbability)
	}
}

func TestValidateConfig(t *testing.T) {
	valid := Config{
		DecisionIntervalVirtualMinutes: config.Distribution{Type: "uniform", Min: 5, Max: 20},
		OrderSizeLots:                  config.Distribution{Type: "uniform", Min: 1, Max: 5},
		BuyProbability:                 0.50,
		MaxPriceDeviationPct:           0.02,
		CancelProbability:              0.30,
		CancelAfterVirtualMinutes:      config.Distribution{Type: "uniform", Min: 5, Max: 15},
		SymbolsUniverse:                SymbolsUniverseConfig{Type: "all_active"},
	}

	if err := ValidateConfig(valid); err != nil {
		t.Errorf("expected valid config, got: %v", err)
	}

	invalidProb := valid
	invalidProb.BuyProbability = 1.5
	if err := ValidateConfig(invalidProb); err == nil {
		t.Errorf("expected error for buy_probability > 1")
	}
}
