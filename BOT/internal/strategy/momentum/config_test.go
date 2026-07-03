package momentum

import (
	"testing"
)

func TestParseConfig_Defaults(t *testing.T) {
	params := map[string]interface{}{}
	cfg, err := ParseConfig(params)
	if err != nil {
		t.Fatalf("unexpected error parsing default config: %v", err)
	}

	if cfg.DecisionIntervalVirtualMinutes.Type != "uniform" || cfg.DecisionIntervalVirtualMinutes.Min != 1 {
		t.Errorf("unexpected default DecisionIntervalVirtualMinutes: %+v", cfg.DecisionIntervalVirtualMinutes)
	}
	if cfg.LookbackVirtualMinutes.Type != "uniform" || cfg.LookbackVirtualMinutes.Min != 10 {
		t.Errorf("unexpected default LookbackVirtualMinutes: %+v", cfg.LookbackVirtualMinutes)
	}
	if cfg.BuyTriggerPct.Type != "normal" || cfg.BuyTriggerPct.Mean != 0.015 {
		t.Errorf("unexpected default BuyTriggerPct: %+v", cfg.BuyTriggerPct)
	}
	if cfg.Confirmation.MinimumTradeCount != 3 {
		t.Errorf("unexpected default Confirmation.MinimumTradeCount: %d", cfg.Confirmation.MinimumTradeCount)
	}
}

func TestValidateConfig_Errors(t *testing.T) {
	tests := []struct {
		name    string
		mutate  func(c *Config)
		wantErr bool
	}{
		{
			name: "invalid buy trigger pct stddev",
			mutate: func(c *Config) {
				c.BuyTriggerPct.StdDev = -1.0
			},
			wantErr: true,
		},
		{
			name: "invalid take profit pct",
			mutate: func(c *Config) {
				c.TakeProfitPct = 1.5
			},
			wantErr: true,
		},
		{
			name: "negative stop loss pct",
			mutate: func(c *Config) {
				c.StopLossPct = -0.5
			},
			wantErr: true,
		},
		{
			name: "negative minimum trade count",
			mutate: func(c *Config) {
				c.Confirmation.MinimumTradeCount = -1
			},
			wantErr: true,
		},
		{
			name: "invalid symbols universe fixed",
			mutate: func(c *Config) {
				c.SymbolsUniverse.Type = "fixed"
				c.SymbolsUniverse.Symbols = []string{}
			},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			params := map[string]interface{}{}
			cfg, err := ParseConfig(params)
			if err != nil {
				t.Fatalf("failed to parse base config: %v", err)
			}
			tt.mutate(&cfg)
			err = ValidateConfig(cfg)
			if (err != nil) != tt.wantErr {
				t.Errorf("ValidateConfig() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}
