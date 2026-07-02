package noise

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/Mandala-Exchange/BOT/internal/config"
)

// SymbolsUniverseConfig defines how the strategy selects symbols to trade.
type SymbolsUniverseConfig struct {
	Type    string   `json:"type" yaml:"type"`
	Count   *int     `json:"count,omitempty" yaml:"count,omitempty"`
	Sector  *string  `json:"sector,omitempty" yaml:"sector,omitempty"`
	Symbols []string `json:"symbols,omitempty" yaml:"symbols,omitempty"`
}

// Config represents the specific parameters for the Noise Trader strategy.
type Config struct {
	DecisionIntervalVirtualMinutes config.Distribution `json:"decision_interval_virtual_minutes" yaml:"decision_interval_virtual_minutes"`
	OrderSizeLots                  config.Distribution `json:"order_size_lots" yaml:"order_size_lots"`
	BuyProbability                 float64             `json:"buy_probability" yaml:"buy_probability"`
	MaxPriceDeviationPct           float64             `json:"max_price_deviation_pct" yaml:"max_price_deviation_pct"`
	CancelProbability              float64             `json:"cancel_probability" yaml:"cancel_probability"`
	CancelAfterVirtualMinutes      config.Distribution `json:"cancel_after_virtual_minutes" yaml:"cancel_after_virtual_minutes"`
	SymbolsUniverse                SymbolsUniverseConfig `json:"symbols_universe" yaml:"symbols_universe"`
}

// ParseConfig extracts and validates the Noise Trader config from the generic bot parameters.
func ParseConfig(params map[string]interface{}) (Config, error) {
	var cfg Config
	
	// Fallback empty config defaults before extraction
	cfg.DecisionIntervalVirtualMinutes = config.Distribution{Type: "uniform", Min: 5, Max: 20}
	cfg.OrderSizeLots = config.Distribution{Type: "uniform", Min: 1, Max: 5}
	cfg.BuyProbability = 0.50
	cfg.MaxPriceDeviationPct = 0.02
	cfg.CancelProbability = 0.30
	cfg.CancelAfterVirtualMinutes = config.Distribution{Type: "uniform", Min: 5, Max: 15}
	cfg.SymbolsUniverse = SymbolsUniverseConfig{Type: "all_active"}

	// Fast path: re-marshal and unmarshal to handle map[string]interface{} to struct
	data, err := json.Marshal(params)
	if err != nil {
		return cfg, fmt.Errorf("failed to encode parameters: %w", err)
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return cfg, fmt.Errorf("failed to parse noise config: %w", err)
	}

	if err := ValidateConfig(cfg); err != nil {
		return cfg, err
	}

	return cfg, nil
}

// ValidateConfig enforces the bounds and constraints defined in BOT_STRATEGY_SPEC.md.
func ValidateConfig(cfg Config) error {
	if err := config.ValidateDistribution(cfg.DecisionIntervalVirtualMinutes, true); err != nil {
		return fmt.Errorf("decision_interval_virtual_minutes: %w", err)
	}
	if err := config.ValidateDistribution(cfg.OrderSizeLots, true); err != nil {
		return fmt.Errorf("order_size_lots: %w", err)
	}
	if err := config.ValidateDistribution(cfg.CancelAfterVirtualMinutes, true); err != nil {
		return fmt.Errorf("cancel_after_virtual_minutes: %w", err)
	}
	if cfg.BuyProbability < 0 || cfg.BuyProbability > 1 {
		return errors.New("buy_probability must be between 0 and 1")
	}
	if cfg.CancelProbability < 0 || cfg.CancelProbability > 1 {
		return errors.New("cancel_probability must be between 0 and 1")
	}
	if cfg.MaxPriceDeviationPct < 0 || cfg.MaxPriceDeviationPct > 1 {
		return errors.New("max_price_deviation_pct must be between 0 and 1")
	}

	// Validate SymbolsUniverse
	switch cfg.SymbolsUniverse.Type {
	case "all_active", "random_n", "sector", "fixed":
		// OK
	default:
		return fmt.Errorf("unsupported symbols_universe type: %q", cfg.SymbolsUniverse.Type)
	}
	
	if cfg.SymbolsUniverse.Type == "fixed" && len(cfg.SymbolsUniverse.Symbols) == 0 {
		return errors.New("symbols_universe type 'fixed' requires at least one symbol")
	}
	if cfg.SymbolsUniverse.Type == "random_n" && (cfg.SymbolsUniverse.Count == nil || *cfg.SymbolsUniverse.Count <= 0) {
		return errors.New("symbols_universe type 'random_n' requires a positive count")
	}
	if cfg.SymbolsUniverse.Type == "sector" && (cfg.SymbolsUniverse.Sector == nil || strings.TrimSpace(*cfg.SymbolsUniverse.Sector) == "") {
		return errors.New("symbols_universe type 'sector' requires a valid sector")
	}

	return nil
}
