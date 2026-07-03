package momentum

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

// ConfirmationConfig holds the momentum confirmation filters.
type ConfirmationConfig struct {
	MinimumTradeCount                int     `json:"minimum_trade_count" yaml:"minimum_trade_count"`
	MinimumPersistenceVirtualSeconds int     `json:"minimum_persistence_virtual_seconds" yaml:"minimum_persistence_virtual_seconds"`
	RequireVolumeSignalProbability  float64 `json:"require_volume_signal_probability" yaml:"require_volume_signal_probability"`
}

// Config represents the specific parameters for the Momentum Trader strategy.
type Config struct {
	DecisionIntervalVirtualMinutes config.Distribution   `json:"decision_interval_virtual_minutes" yaml:"decision_interval_virtual_minutes"`
	LookbackVirtualMinutes         config.Distribution   `json:"lookback_virtual_minutes" yaml:"lookback_virtual_minutes"`
	BuyTriggerPct                  config.Distribution   `json:"buy_trigger_pct" yaml:"buy_trigger_pct"`
	SellTriggerPct                 config.Distribution   `json:"sell_trigger_pct" yaml:"sell_trigger_pct"`
	Confirmation                   ConfirmationConfig    `json:"confirmation" yaml:"confirmation"`
	EntryHysteresisPct             float64               `json:"entry_hysteresis_pct" yaml:"entry_hysteresis_pct"`
	CooldownVirtualMinutes         config.Distribution   `json:"cooldown_virtual_minutes" yaml:"cooldown_virtual_minutes"`
	TakeProfitPct                  float64               `json:"take_profit_pct" yaml:"take_profit_pct"`
	StopLossPct                    float64               `json:"stop_loss_pct" yaml:"stop_loss_pct"`
	OrderSizeLots                  config.Distribution   `json:"order_size_lots" yaml:"order_size_lots"`
	SymbolsUniverse                SymbolsUniverseConfig `json:"symbols_universe" yaml:"symbols_universe"`
}

// ParseConfig extracts and validates the Momentum Trader config from generic parameters.
func ParseConfig(params map[string]interface{}) (Config, error) {
	var cfg Config

	// Default parameters as defined in BOT_STRATEGY_SPEC.md §8 and reasonable defaults
	cfg.DecisionIntervalVirtualMinutes = config.Distribution{Type: "uniform", Min: 1, Max: 5}
	cfg.LookbackVirtualMinutes = config.Distribution{Type: "uniform", Min: 10, Max: 30}
	cfg.BuyTriggerPct = config.Distribution{Type: "normal", Mean: 0.015, StdDev: 0.004, Min: 0.007, Max: 0.028, Clamp: true}
	cfg.SellTriggerPct = config.Distribution{Type: "normal", Mean: -0.015, StdDev: 0.004, Min: -0.028, Max: -0.007, Clamp: true}
	cfg.Confirmation = ConfirmationConfig{
		MinimumTradeCount:                3,
		MinimumPersistenceVirtualSeconds: 15,
		RequireVolumeSignalProbability:  0.70,
	}
	cfg.EntryHysteresisPct = 0.003
	cfg.CooldownVirtualMinutes = config.Distribution{Type: "uniform", Min: 10, Max: 40}
	cfg.TakeProfitPct = 0.03
	cfg.StopLossPct = 0.02
	cfg.OrderSizeLots = config.Distribution{Type: "uniform", Min: 5, Max: 20}
	cfg.SymbolsUniverse = SymbolsUniverseConfig{Type: "all_active"}

	// Marshal and unmarshal to convert map[string]interface{} to Config
	data, err := json.Marshal(params)
	if err != nil {
		return cfg, fmt.Errorf("failed to encode parameters: %w", err)
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return cfg, fmt.Errorf("failed to parse momentum config: %w", err)
	}

	if err := ValidateConfig(cfg); err != nil {
		return cfg, err
	}

	return cfg, nil
}

// ValidateConfig enforces the bounds and constraints.
func ValidateConfig(cfg Config) error {
	if err := config.ValidateDistribution(cfg.DecisionIntervalVirtualMinutes, true); err != nil {
		return fmt.Errorf("decision_interval_virtual_minutes: %w", err)
	}
	if err := config.ValidateDistribution(cfg.LookbackVirtualMinutes, true); err != nil {
		return fmt.Errorf("lookback_virtual_minutes: %w", err)
	}
	if err := config.ValidateDistribution(cfg.BuyTriggerPct, true); err != nil {
		return fmt.Errorf("buy_trigger_pct: %w", err)
	}
	if err := config.ValidateDistribution(cfg.SellTriggerPct, false); err != nil {
		return fmt.Errorf("sell_trigger_pct: %w", err)
	}
	if err := config.ValidateDistribution(cfg.CooldownVirtualMinutes, true); err != nil {
		return fmt.Errorf("cooldown_virtual_minutes: %w", err)
	}
	if err := config.ValidateDistribution(cfg.OrderSizeLots, true); err != nil {
		return fmt.Errorf("order_size_lots: %w", err)
	}
	if cfg.EntryHysteresisPct < 0 || cfg.EntryHysteresisPct > 1 {
		return errors.New("entry_hysteresis_pct must be between 0 and 1")
	}
	if cfg.TakeProfitPct < 0 || cfg.TakeProfitPct > 1 {
		return errors.New("take_profit_pct must be between 0 and 1")
	}
	if cfg.StopLossPct < 0 || cfg.StopLossPct > 1 {
		return errors.New("stop_loss_pct must be between 0 and 1")
	}
	if cfg.Confirmation.MinimumTradeCount < 0 {
		return errors.New("minimum_trade_count cannot be negative")
	}
	if cfg.Confirmation.MinimumPersistenceVirtualSeconds < 0 {
		return errors.New("minimum_persistence_virtual_seconds cannot be negative")
	}
	if cfg.Confirmation.RequireVolumeSignalProbability < 0 || cfg.Confirmation.RequireVolumeSignalProbability > 1 {
		return errors.New("require_volume_signal_probability must be between 0 and 1")
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
