package marketmaker

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/Mandala-Exchange/BOT/internal/config"
)

// SymbolsUniverseConfig defines how the strategy selects symbols to trade if Symbol is empty.
type SymbolsUniverseConfig struct {
	Type    string   `json:"type" yaml:"type"`
	Count   *int     `json:"count,omitempty" yaml:"count,omitempty"`
	Sector  *string  `json:"sector,omitempty" yaml:"sector,omitempty"`
	Symbols []string `json:"symbols,omitempty" yaml:"symbols,omitempty"`
}

// Config represents the specific parameters for the Market Maker strategy.
type Config struct {
	Symbol                string              `json:"symbol,omitempty" yaml:"symbol,omitempty"`
	SymbolsUniverse       SymbolsUniverseConfig `json:"symbols_universe,omitempty" yaml:"symbols_universe,omitempty"`
	Levels                int                 `json:"levels" yaml:"levels"`
	SpreadTicks           config.Distribution `json:"spread_ticks" yaml:"spread_ticks"`
	LevelSizeLots         config.Distribution `json:"level_size_lots" yaml:"level_size_lots"`
	RefreshVirtualSeconds config.Distribution `json:"refresh_virtual_seconds" yaml:"refresh_virtual_seconds"`
	MaxInventoryLots      int64               `json:"max_inventory_lots" yaml:"max_inventory_lots"`
	InventorySkewStrength float64             `json:"inventory_skew_strength" yaml:"inventory_skew_strength"`
	FeeAware              bool                `json:"fee_aware" yaml:"fee_aware"`
	SelfTradePrevention   string              `json:"self_trade_prevention" yaml:"self_trade_prevention"`
}

// ParseConfig extracts and validates the Market Maker config from the generic bot parameters.
func ParseConfig(params map[string]interface{}) (Config, error) {
	var cfg Config

	// Fallback empty config defaults before extraction
	cfg.Symbol = ""
	cfg.SymbolsUniverse = SymbolsUniverseConfig{Type: "all_active"}
	cfg.Levels = 3
	cfg.SpreadTicks = config.Distribution{Type: "uniform", Min: 2, Max: 6}
	cfg.LevelSizeLots = config.Distribution{Type: "uniform", Min: 5, Max: 25}
	cfg.RefreshVirtualSeconds = config.Distribution{Type: "uniform", Min: 20, Max: 45}
	cfg.MaxInventoryLots = 100
	cfg.InventorySkewStrength = 0.50
	cfg.FeeAware = true
	cfg.SelfTradePrevention = "cancel_newest"

	// Fast path: re-marshal and unmarshal to handle map[string]interface{} to struct
	data, err := json.Marshal(params)
	if err != nil {
		return cfg, fmt.Errorf("failed to encode parameters: %w", err)
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return cfg, fmt.Errorf("failed to parse market maker config: %w", err)
	}

	if err := ValidateConfig(cfg); err != nil {
		return cfg, err
	}

	return cfg, nil
}

// ValidateConfig enforces the bounds and constraints defined in BOT_STRATEGY_SPEC.md §10.
func ValidateConfig(cfg Config) error {
	if strings.TrimSpace(cfg.Symbol) == "" && strings.TrimSpace(cfg.SymbolsUniverse.Type) == "" {
		return errors.New("either symbol or symbols_universe must be provided")
	}
	if cfg.Levels <= 0 {
		return errors.New("levels must be greater than 0")
	}
	if err := config.ValidateDistribution(cfg.SpreadTicks, true); err != nil {
		return fmt.Errorf("spread_ticks: %w", err)
	}
	if err := config.ValidateDistribution(cfg.LevelSizeLots, true); err != nil {
		return fmt.Errorf("level_size_lots: %w", err)
	}
	if err := config.ValidateDistribution(cfg.RefreshVirtualSeconds, true); err != nil {
		return fmt.Errorf("refresh_virtual_seconds: %w", err)
	}
	if cfg.MaxInventoryLots <= 0 {
		return errors.New("max_inventory_lots must be greater than 0")
	}
	if cfg.InventorySkewStrength < 0 || cfg.InventorySkewStrength > 1 {
		return errors.New("inventory_skew_strength must be between 0 and 1")
	}

	switch cfg.SelfTradePrevention {
	case "cancel_newest", "cancel_oldest", "cancel_both", "none":
		// OK
	default:
		return fmt.Errorf("unsupported self_trade_prevention: %q", cfg.SelfTradePrevention)
	}

	return nil
}
