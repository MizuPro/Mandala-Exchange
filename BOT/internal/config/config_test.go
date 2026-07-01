package config

import (
	"strings"
	"testing"
)

func TestLoadEnvRequiresDedicatedSessionSeedSecret(t *testing.T) {
	values := map[string]string{
		"APP_ENV": "development", "BOT_HTTP_ADDR": "127.0.0.1:9090",
		"BOT_DATABASE_URL": "postgres://localhost/bot", "REDIS_URL": "redis://localhost:6379",
		"SEKURITAS_BASE_URL": "http://localhost:3000", "MATS_WS_URL": "ws://localhost:8082/ws",
		"BEI_BASE_URL": "http://localhost:4100", "BOT_SERVICE_TOKEN": strings.Repeat("s", 32),
	}
	for name, value := range values {
		t.Setenv(name, value)
	}
	t.Setenv("BOT_SESSION_SEED_SECRET", "")
	if _, err := LoadEnv(); err == nil || !strings.Contains(err.Error(), "BOT_SESSION_SEED_SECRET") {
		t.Fatalf("missing dedicated seed secret was accepted: %v", err)
	}
	t.Setenv("BOT_SESSION_SEED_SECRET", strings.Repeat("h", 32))
	if _, err := LoadEnv(); err != nil {
		t.Fatalf("valid dedicated seed secret rejected: %v", err)
	}
}

func TestLoadEnvDecisionLogConfig(t *testing.T) {
	values := map[string]string{
		"APP_ENV": "development", "BOT_HTTP_ADDR": "127.0.0.1:9090",
		"BOT_DATABASE_URL": "postgres://localhost/bot", "REDIS_URL": "redis://localhost:6379",
		"SEKURITAS_BASE_URL": "http://localhost:3000", "MATS_WS_URL": "ws://localhost:8082/ws",
		"BEI_BASE_URL": "http://localhost:4100", "BOT_SERVICE_TOKEN": strings.Repeat("s", 32),
		"BOT_SESSION_SEED_SECRET":     strings.Repeat("h", 32),
		"BOT_DECISION_LOG_BATCH_SIZE": "250", "BOT_DECISION_LOG_FLUSH_SECONDS": "3",
		"BOT_DECISION_HOLD_SAMPLE_RATE": "0", "BOT_DECISION_LOG_RETENTION_SESSIONS": "45",
	}
	for name, value := range values {
		t.Setenv(name, value)
	}
	cfg, err := LoadEnv()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DecisionLogBatchSize != 250 || cfg.DecisionLogFlushInterval.Seconds() != 3 ||
		cfg.DecisionLogHoldSampleRate != 0 || cfg.DecisionLogRetentionSessions != 45 {
		t.Fatalf("unexpected decision log config: %+v", cfg)
	}
}

func TestLoadEnvRejectsInvalidDecisionLogConfig(t *testing.T) {
	values := map[string]string{
		"APP_ENV": "development", "BOT_HTTP_ADDR": "127.0.0.1:9090",
		"BOT_DATABASE_URL": "postgres://localhost/bot", "REDIS_URL": "redis://localhost:6379",
		"SEKURITAS_BASE_URL": "http://localhost:3000", "MATS_WS_URL": "ws://localhost:8082/ws",
		"BEI_BASE_URL": "http://localhost:4100", "BOT_SERVICE_TOKEN": strings.Repeat("s", 32),
		"BOT_SESSION_SEED_SECRET": strings.Repeat("h", 32),
	}
	for name, value := range values {
		t.Setenv(name, value)
	}
	for name, value := range map[string]string{
		"BOT_DECISION_LOG_BATCH_SIZE":         "99",
		"BOT_DECISION_LOG_FLUSH_SECONDS":      "6",
		"BOT_DECISION_HOLD_SAMPLE_RATE":       "1.1",
		"BOT_DECISION_LOG_RETENTION_SESSIONS": "0",
	} {
		t.Run(name, func(t *testing.T) {
			t.Setenv(name, value)
			if _, err := LoadEnv(); err == nil {
				t.Fatalf("%s=%s was accepted", name, value)
			}
		})
	}
}

// ── ValidateBotConfig Tests ───────────────────────────────────────────────────

func TestValidateBotConfig_HappyPath(t *testing.T) {
	cfg := BotConfig{
		ExternalBotID: "noise-0001",
		StrategyType:  "noise_trader",
		Risk:          DefaultRiskConfig(),
	}
	if err := ValidateBotConfig(cfg); err != nil {
		t.Errorf("expected valid config, got error: %v", err)
	}
}

func TestValidateBotConfig_MissingExternalBotID(t *testing.T) {
	cfg := BotConfig{
		StrategyType: "noise_trader",
		Risk:         DefaultRiskConfig(),
	}
	if err := ValidateBotConfig(cfg); err == nil {
		t.Error("expected error for missing external_bot_id")
	}
}

func TestValidateBotConfig_UnknownStrategy(t *testing.T) {
	cfg := BotConfig{
		ExternalBotID: "bot1",
		StrategyType:  "super_hft_trader",
		Risk:          DefaultRiskConfig(),
	}
	if err := ValidateBotConfig(cfg); err == nil {
		t.Error("expected error for unknown strategy_type")
	}
}

func TestValidateBotConfig_AllValidStrategies(t *testing.T) {
	strategies := []string{
		"noise_trader", "momentum_trader", "market_maker",
		"contrarian", "value_investor", "bandar",
		"event_driven", "index_tracker",
	}
	for _, s := range strategies {
		cfg := BotConfig{
			ExternalBotID: "bot-" + s,
			StrategyType:  s,
			Risk:          DefaultRiskConfig(),
		}
		if err := ValidateBotConfig(cfg); err != nil {
			t.Errorf("strategy %q should be valid, got: %v", s, err)
		}
	}
}

func TestValidateBotConfigRejectsPanicSellerAsAutonomousStrategy(t *testing.T) {
	cfg := BotConfig{
		ExternalBotID: "panic-1",
		StrategyType:  "panic_seller",
		Risk:          DefaultRiskConfig(),
	}
	if err := ValidateBotConfig(cfg); err == nil {
		t.Fatal("panic seller must only be created as a simulation scenario actor")
	}
}

// ── ValidateRiskConfig Tests (typed bounds per BOT_STRATEGY_SPEC.md §4) ───────

func TestValidateRiskConfig_ZeroLots(t *testing.T) {
	r := DefaultRiskConfig()
	r.MaxOrderSizeLots = 0
	if err := ValidateRiskConfig(r); err == nil {
		t.Error("expected error for zero max_order_size_lots")
	}
}

func TestValidateRiskConfig_ExposureOutOfBounds(t *testing.T) {
	r := DefaultRiskConfig()
	r.MaxSymbolExposurePct = 0 // must be > 0
	if err := ValidateRiskConfig(r); err == nil {
		t.Error("expected error for zero exposure_pct")
	}
	r.MaxSymbolExposurePct = 1.5 // must be <= 1
	if err := ValidateRiskConfig(r); err == nil {
		t.Error("expected error for exposure_pct > 1")
	}
}

func TestValidateRiskConfig_WeeklyLessThanDaily(t *testing.T) {
	r := DefaultRiskConfig()
	r.MaxDailyLossPct = 0.10
	r.MaxWeeklyLossPct = 0.05 // weekly must be >= daily
	if err := ValidateRiskConfig(r); err == nil {
		t.Error("expected error when weekly_loss_pct < daily_loss_pct")
	}
}

func TestValidateRiskConfig_ZeroOrdersPerMinute(t *testing.T) {
	r := DefaultRiskConfig()
	r.MaxOrdersPerMinute = 0
	if err := ValidateRiskConfig(r); err == nil {
		t.Error("expected error for zero max_orders_per_minute")
	}
}

func TestValidateRiskConfig_ValidDefaults(t *testing.T) {
	r := DefaultRiskConfig()
	if err := ValidateRiskConfig(r); err != nil {
		t.Errorf("compiled defaults should be valid, got: %v", err)
	}
}

func TestValidateHumanAndActivityConfig(t *testing.T) {
	if err := ValidateHumanConfig(DefaultHumanConfig()); err != nil {
		t.Fatalf("default human config invalid: %v", err)
	}
	if err := ValidateActivityConfig(DefaultActivityConfig()); err != nil {
		t.Fatalf("default activity config invalid: %v", err)
	}
	h := DefaultHumanConfig()
	h.DecisionAbortProbability = 1.01
	if err := ValidateHumanConfig(h); err == nil {
		t.Fatal("probability above one must be rejected")
	}
	a := DefaultActivityConfig()
	a.ClosingRushStartProgress = a.MorningRushEndProgress
	if err := ValidateActivityConfig(a); err == nil {
		t.Fatal("overlapping U-curve windows must be rejected")
	}
}

func TestValidateDistributionRejectsAmbiguousFields(t *testing.T) {
	if err := ValidateDistribution(Distribution{Type: "uniform", Min: 1, Max: 2, Mean: 1.5}, true); err == nil {
		t.Fatal("uniform mean must not be silently ignored")
	}
	if err := ValidateDistribution(Distribution{Type: "normal", Min: 1, Max: 2, Mean: 1.5, StdDev: .2}, true); err == nil {
		t.Fatal("unclamped normal distribution must be rejected")
	}
}

func TestNormalizeBotConfigMaterializesRealismDefaults(t *testing.T) {
	cfg, err := NormalizeBotConfig(BotConfig{
		ExternalBotID: "bot-defaults",
		StrategyType:  "noise_trader",
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Human.ReactionDelayVirtualSeconds.Type == "" ||
		cfg.Activity.MorningMultiplier.Type == "" ||
		cfg.Risk.MaxOrderSizeLots == 0 {
		t.Fatalf("defaults were not materialized: %+v", cfg)
	}
}

// ── Config Precedence Tests ──────────────────────────────────────────────────

// TestCompiledDefaultsApplied verifies that compiled defaults are non-zero
// and are applied when risk config is not specified.
func TestCompiledDefaultsApplied(t *testing.T) {
	r := DefaultRiskConfig()
	if r.MaxOrderSizeLots != DefaultMaxOrderSizeLots {
		t.Errorf("expected compiled default lots=%d, got %d", DefaultMaxOrderSizeLots, r.MaxOrderSizeLots)
	}
	if r.MaxSymbolExposurePct != DefaultMaxSymbolExposurePct {
		t.Errorf("expected compiled default exposure=%.2f, got %.2f", DefaultMaxSymbolExposurePct, r.MaxSymbolExposurePct)
	}
	if r.MaxDailyLossPct != DefaultMaxDailyLossPct {
		t.Errorf("expected compiled default daily_loss=%.2f, got %.2f", DefaultMaxDailyLossPct, r.MaxDailyLossPct)
	}
}

// TestValidateBotConfig_ZeroRiskAppliesDefaults verifies that a BotConfig
// with zero-value risk receives compiled defaults.
func TestValidateBotConfig_ZeroRiskAppliesDefaults(t *testing.T) {
	cfg := BotConfig{
		ExternalBotID: "bot1",
		StrategyType:  "noise_trader",
		// Risk is zero-value — defaults should be applied internally by validator
	}
	// ValidateBotConfig internally applies defaults when MaxOrderSizeLots==0
	if err := ValidateBotConfig(cfg); err != nil {
		t.Errorf("zero-value risk with defaults should be valid, got: %v", err)
	}
}
