package config

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"gopkg.in/yaml.v3"
)

// ── Compiled Defaults ─────────────────────────────────────────────────────────
// These are the lowest-priority defaults baked into the binary.
// They are overridden by YAML bootstrap, then DB persisted config, then runtime override.

// DefaultMaxOrderSizeLots is the compiled default for max order size in lots.
const DefaultMaxOrderSizeLots = 20

// DefaultMaxSymbolExposurePct is the compiled default for max symbol exposure.
const DefaultMaxSymbolExposurePct = 0.30

// DefaultMaxDailyLossPct is the compiled default for max daily loss.
const DefaultMaxDailyLossPct = 0.05

// DefaultMaxWeeklyLossPct is the compiled default for max weekly loss.
const DefaultMaxWeeklyLossPct = 0.15

// DefaultMaxInventoryShares caps total per-symbol inventory across all states.
const DefaultMaxInventoryShares int64 = 10_000

// DefaultMaxLiquidationShares bounds each forced liquidation slice.
const DefaultMaxLiquidationShares int64 = 2_000

// DefaultMaxOrdersPerMinute is the compiled default rate limit.
const DefaultMaxOrdersPerMinute = 10

const (
	DefaultPriceFatFingerProbability  = 0.02
	DefaultPriceFatFingerRangeTicks   = 3
	DefaultDecisionAbortProbability   = 0.10
	DefaultOverreactionProbability    = 0.15
	DefaultInactiveSessionProbability = 0.05
)

// ValidStrategyTypes is the set of strategy type identifiers allowed by PRD.
var ValidStrategyTypes = map[string]struct{}{
	"noise_trader":    {},
	"momentum_trader": {},
	"market_maker":    {},
	"contrarian":      {},
	"value_investor":  {},
	"bandar":          {},
	"event_driven":    {},
	"index_tracker":   {},
}

// ── Risk Config (typed bounds per BOT_STRATEGY_SPEC.md §4) ──────────────────

// RiskConfig holds strategy risk parameters. All fields have validated bounds.
type RiskConfig struct {
	MaxOrderSizeLots     int     `yaml:"max_order_size_lots" json:"max_order_size_lots"`
	MaxSymbolExposurePct float64 `yaml:"max_symbol_exposure_pct" json:"max_symbol_exposure_pct"`
	MaxDailyLossPct      float64 `yaml:"max_daily_loss_pct" json:"max_daily_loss_pct"`
	MaxWeeklyLossPct     float64 `yaml:"max_weekly_loss_pct" json:"max_weekly_loss_pct"`
	MaxInventoryShares   int64   `yaml:"max_inventory_shares" json:"max_inventory_shares"`
	MaxLiquidationShares int64   `yaml:"max_liquidation_shares" json:"max_liquidation_shares"`
	MaxOrdersPerMinute   int     `yaml:"max_orders_per_minute" json:"max_orders_per_minute"`
}

// Distribution is the machine-valid bounded distribution used by strategy and
// realism parameters. Fields that do not apply to a distribution type are
// rejected rather than silently ignored.
type Distribution struct {
	Type   string  `yaml:"type" json:"type"`
	Min    float64 `yaml:"min,omitempty" json:"min,omitempty"`
	Max    float64 `yaml:"max,omitempty" json:"max,omitempty"`
	Mean   float64 `yaml:"mean,omitempty" json:"mean,omitempty"`
	StdDev float64 `yaml:"stddev,omitempty" json:"stddev,omitempty"`
	Clamp  bool    `yaml:"clamp,omitempty" json:"clamp,omitempty"`
}

// HumanConfig controls bounded imperfections. Delay values use virtual seconds
// and are converted through the authoritative session compression ratio.
type HumanConfig struct {
	ReactionDelayVirtualSeconds Distribution `yaml:"reaction_delay_virtual_seconds" json:"reaction_delay_virtual_seconds"`
	PriceFatFingerProbability   float64      `yaml:"price_fat_finger_probability" json:"price_fat_finger_probability"`
	PriceFatFingerRangeTicks    int          `yaml:"price_fat_finger_range_ticks" json:"price_fat_finger_range_ticks"`
	DecisionAbortProbability    float64      `yaml:"decision_abort_probability" json:"decision_abort_probability"`
	OverreactionProbability     float64      `yaml:"overreaction_probability" json:"overreaction_probability"`
	OverreactionMultiplier      Distribution `yaml:"overreaction_multiplier" json:"overreaction_multiplier"`
	InactiveSessionProbability  float64      `yaml:"inactive_session_probability" json:"inactive_session_probability"`
}

// ActivityConfig defines the continuous-session U curve. Thresholds are
// fractions of the current segment duration, never wall-clock times.
type ActivityConfig struct {
	MorningRushEndProgress   float64      `yaml:"morning_rush_end_progress" json:"morning_rush_end_progress"`
	ClosingRushStartProgress float64      `yaml:"closing_rush_start_progress" json:"closing_rush_start_progress"`
	MorningMultiplier        Distribution `yaml:"morning_multiplier" json:"morning_multiplier"`
	MiddayMultiplier         Distribution `yaml:"midday_multiplier" json:"midday_multiplier"`
	ClosingMultiplier        Distribution `yaml:"closing_multiplier" json:"closing_multiplier"`
}

func DefaultHumanConfig() HumanConfig {
	return HumanConfig{
		ReactionDelayVirtualSeconds: Distribution{Type: "uniform", Min: 5, Max: 45},
		PriceFatFingerProbability:   DefaultPriceFatFingerProbability,
		PriceFatFingerRangeTicks:    DefaultPriceFatFingerRangeTicks,
		DecisionAbortProbability:    DefaultDecisionAbortProbability,
		OverreactionProbability:     DefaultOverreactionProbability,
		OverreactionMultiplier:      Distribution{Type: "uniform", Min: 1.2, Max: 2},
		InactiveSessionProbability:  DefaultInactiveSessionProbability,
	}
}

func DefaultActivityConfig() ActivityConfig {
	return ActivityConfig{
		MorningRushEndProgress:   0.30,
		ClosingRushStartProgress: 0.85,
		MorningMultiplier:        Distribution{Type: "uniform", Min: 3, Max: 5},
		MiddayMultiplier:         Distribution{Type: "uniform", Min: 0.75, Max: 1},
		ClosingMultiplier:        Distribution{Type: "uniform", Min: 3, Max: 5},
	}
}

func ValidateDistribution(d Distribution, positive bool) error {
	switch d.Type {
	case "fixed":
		if d.Min != d.Max || d.StdDev != 0 || d.Mean != 0 {
			return errors.New("fixed distribution requires equal min/max and no mean/stddev")
		}
	case "uniform":
		if d.Min > d.Max || d.Mean != 0 || d.StdDev != 0 {
			return errors.New("uniform distribution requires min <= max and no mean/stddev")
		}
	case "normal", "lognormal":
		if d.Min > d.Max || d.StdDev <= 0 {
			return fmt.Errorf("%s distribution requires min <= max and positive stddev", d.Type)
		}
		if !d.Clamp {
			return fmt.Errorf("%s distribution must be clamped", d.Type)
		}
	default:
		return fmt.Errorf("unsupported distribution type %q", d.Type)
	}
	if positive && d.Min <= 0 {
		return errors.New("distribution minimum must be positive")
	}
	return nil
}

func ValidateHumanConfig(h HumanConfig) error {
	if err := ValidateDistribution(h.ReactionDelayVirtualSeconds, true); err != nil {
		return fmt.Errorf("reaction_delay_virtual_seconds: %w", err)
	}
	if err := ValidateDistribution(h.OverreactionMultiplier, true); err != nil {
		return fmt.Errorf("overreaction_multiplier: %w", err)
	}
	for name, value := range map[string]float64{
		"price_fat_finger_probability": h.PriceFatFingerProbability,
		"decision_abort_probability":   h.DecisionAbortProbability,
		"overreaction_probability":     h.OverreactionProbability,
		"inactive_session_probability": h.InactiveSessionProbability,
	} {
		if value < 0 || value > 1 {
			return fmt.Errorf("%s must be in [0, 1]", name)
		}
	}
	if h.PriceFatFingerRangeTicks < 0 {
		return errors.New("price_fat_finger_range_ticks must not be negative")
	}
	if h.OverreactionMultiplier.Min < 1 {
		return errors.New("overreaction_multiplier must not reduce order size")
	}
	return nil
}

func ValidateActivityConfig(a ActivityConfig) error {
	if a.MorningRushEndProgress <= 0 || a.MorningRushEndProgress >= 1 {
		return errors.New("morning_rush_end_progress must be in (0, 1)")
	}
	if a.ClosingRushStartProgress <= a.MorningRushEndProgress || a.ClosingRushStartProgress >= 1 {
		return errors.New("closing_rush_start_progress must be after morning rush and below 1")
	}
	for name, d := range map[string]Distribution{
		"morning_multiplier": a.MorningMultiplier,
		"midday_multiplier":  a.MiddayMultiplier,
		"closing_multiplier": a.ClosingMultiplier,
	} {
		if err := ValidateDistribution(d, true); err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
	}
	return nil
}

// DefaultRiskConfig returns compiled default risk parameters.
func DefaultRiskConfig() RiskConfig {
	return RiskConfig{
		MaxOrderSizeLots:     DefaultMaxOrderSizeLots,
		MaxSymbolExposurePct: DefaultMaxSymbolExposurePct,
		MaxDailyLossPct:      DefaultMaxDailyLossPct,
		MaxWeeklyLossPct:     DefaultMaxWeeklyLossPct,
		MaxInventoryShares:   DefaultMaxInventoryShares,
		MaxLiquidationShares: DefaultMaxLiquidationShares,
		MaxOrdersPerMinute:   DefaultMaxOrdersPerMinute,
	}
}

// ValidateRiskConfig validates typed bounds per BOT_STRATEGY_SPEC.md §4.
func ValidateRiskConfig(r RiskConfig) error {
	if r.MaxOrderSizeLots <= 0 {
		return errors.New("max_order_size_lots must be positive")
	}
	if r.MaxSymbolExposurePct <= 0 || r.MaxSymbolExposurePct > 1 {
		return errors.New("max_symbol_exposure_pct must be in (0, 1]")
	}
	if r.MaxDailyLossPct <= 0 || r.MaxDailyLossPct > 1 {
		return errors.New("max_daily_loss_pct must be in (0, 1]")
	}
	if r.MaxWeeklyLossPct <= 0 || r.MaxWeeklyLossPct > 1 {
		return errors.New("max_weekly_loss_pct must be in (0, 1]")
	}
	if r.MaxWeeklyLossPct < r.MaxDailyLossPct {
		return errors.New("max_weekly_loss_pct must be >= max_daily_loss_pct")
	}
	if r.MaxInventoryShares < 0 {
		return errors.New("max_inventory_shares must not be negative")
	}
	if r.MaxLiquidationShares < 0 {
		return errors.New("max_liquidation_shares must not be negative")
	}
	if r.MaxInventoryShares > 0 && r.MaxLiquidationShares > r.MaxInventoryShares {
		return errors.New("max_liquidation_shares must be <= max_inventory_shares")
	}
	if r.MaxOrdersPerMinute <= 0 {
		return errors.New("max_orders_per_minute must be positive")
	}
	return nil
}

// ── Bot Config ────────────────────────────────────────────────────────────────

// BotConfig represents the configuration for a single bot.
// This is the merge result of compiled defaults → YAML bootstrap → DB config → runtime override.
type BotConfig struct {
	ExternalBotID string                 `yaml:"external_bot_id" json:"external_bot_id"`
	StrategyType  string                 `yaml:"strategy_type" json:"strategy_type"`
	Risk          RiskConfig             `yaml:"risk" json:"risk"`
	Human         HumanConfig            `yaml:"human" json:"human"`
	Activity      ActivityConfig         `yaml:"activity" json:"activity"`
	Parameters    map[string]interface{} `yaml:"parameters" json:"parameters"`
	ConfigVersion int64                  `yaml:"config_version,omitempty" json:"config_version,omitempty"`
}

// ValidateBotConfig validates a BotConfig against all typed bounds.
// This is the per-strategy validation required by Task 1.4.
func ValidateBotConfig(cfg BotConfig) error {
	if strings.TrimSpace(cfg.ExternalBotID) == "" {
		return errors.New("external_bot_id is required")
	}
	if strings.TrimSpace(cfg.StrategyType) == "" {
		return errors.New("strategy_type is required")
	}
	if _, ok := ValidStrategyTypes[cfg.StrategyType]; !ok {
		return fmt.Errorf("strategy_type %q is not a known strategy", cfg.StrategyType)
	}
	// Apply compiled defaults for zero-value risk config
	if cfg.Risk.MaxOrderSizeLots == 0 {
		cfg.Risk = DefaultRiskConfig()
	}
	if cfg.Human.ReactionDelayVirtualSeconds.Type == "" {
		cfg.Human = DefaultHumanConfig()
	}
	if cfg.Activity.MorningMultiplier.Type == "" {
		cfg.Activity = DefaultActivityConfig()
	}
	if err := ValidateRiskConfig(cfg.Risk); err != nil {
		return err
	}
	if err := ValidateHumanConfig(cfg.Human); err != nil {
		return err
	}
	return ValidateActivityConfig(cfg.Activity)
}

// NormalizeBotConfig materializes compiled defaults before persistence so a
// restart observes the same effective config that validation approved.
func NormalizeBotConfig(cfg BotConfig) (BotConfig, error) {
	if cfg.Risk.MaxOrderSizeLots == 0 {
		cfg.Risk = DefaultRiskConfig()
	}
	if cfg.Human.ReactionDelayVirtualSeconds.Type == "" {
		cfg.Human = DefaultHumanConfig()
	}
	if cfg.Activity.MorningMultiplier.Type == "" {
		cfg.Activity = DefaultActivityConfig()
	}
	if err := ValidateBotConfig(cfg); err != nil {
		return BotConfig{}, err
	}
	return cfg, nil
}

// ── App Config (env layer) ─────────────────────────────────────────────────────

// AppConfig holds environment-level configuration (from environment variables).
type AppConfig struct {
	AppEnv                       string
	HTTPAddr                     string
	DatabaseURL                  string
	RedisURL                     string
	SekuritasBaseURL             string
	MatsWSURL                    string
	BeiBaseURL                   string
	ServiceToken                 string
	SessionSeedSecret            string
	DecisionLogBatchSize         int
	DecisionLogFlushInterval     time.Duration
	DecisionLogHoldSampleRate    float64
	DecisionLogRetentionSessions int
}

// LoadEnv loads and validates environment variables. This is the env layer,
// which is separate from strategy config precedence.
func LoadEnv() (*AppConfig, error) {
	cfg := &AppConfig{
		AppEnv:                       os.Getenv("APP_ENV"),
		HTTPAddr:                     os.Getenv("BOT_HTTP_ADDR"),
		DatabaseURL:                  os.Getenv("BOT_DATABASE_URL"),
		RedisURL:                     os.Getenv("REDIS_URL"),
		SekuritasBaseURL:             os.Getenv("SEKURITAS_BASE_URL"),
		MatsWSURL:                    os.Getenv("MATS_WS_URL"),
		BeiBaseURL:                   os.Getenv("BEI_BASE_URL"),
		ServiceToken:                 os.Getenv("BOT_SERVICE_TOKEN"),
		SessionSeedSecret:            os.Getenv("BOT_SESSION_SEED_SECRET"),
		DecisionLogBatchSize:         500,
		DecisionLogFlushInterval:     5 * time.Second,
		DecisionLogHoldSampleRate:    0.02,
		DecisionLogRetentionSessions: 30,
	}
	if err := loadDecisionLogEnv(cfg); err != nil {
		return nil, err
	}
	var missing []string
	for name, value := range map[string]string{
		"APP_ENV": cfg.AppEnv, "BOT_HTTP_ADDR": cfg.HTTPAddr, "BOT_DATABASE_URL": cfg.DatabaseURL,
		"REDIS_URL": cfg.RedisURL, "SEKURITAS_BASE_URL": cfg.SekuritasBaseURL,
		"MATS_WS_URL": cfg.MatsWSURL, "BEI_BASE_URL": cfg.BeiBaseURL, "BOT_SERVICE_TOKEN": cfg.ServiceToken,
		"BOT_SESSION_SEED_SECRET": cfg.SessionSeedSecret,
	} {
		if strings.TrimSpace(value) == "" {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		return nil, fmt.Errorf("missing required environment: %s", strings.Join(missing, ", "))
	}
	if cfg.AppEnv != "development" && cfg.AppEnv != "production" {
		return nil, errors.New("APP_ENV must be development or production")
	}
	if len(cfg.ServiceToken) < 32 {
		return nil, errors.New("BOT_SERVICE_TOKEN must contain at least 32 characters")
	}
	if len(cfg.SessionSeedSecret) < 32 {
		return nil, errors.New("BOT_SESSION_SEED_SECRET must contain at least 32 characters")
	}
	for name, value := range map[string]string{"BOT_DATABASE_URL": cfg.DatabaseURL, "REDIS_URL": cfg.RedisURL, "SEKURITAS_BASE_URL": cfg.SekuritasBaseURL, "MATS_WS_URL": cfg.MatsWSURL, "BEI_BASE_URL": cfg.BeiBaseURL} {
		if _, err := url.ParseRequestURI(value); err != nil {
			return nil, fmt.Errorf("%s is invalid: %w", name, err)
		}
	}
	if cfg.AppEnv == "production" && strings.Contains(strings.ToLower(cfg.ServiceToken), "dev-") {
		return nil, errors.New("development BOT_SERVICE_TOKEN is forbidden in production")
	}
	if cfg.AppEnv == "production" && strings.Contains(strings.ToLower(cfg.SessionSeedSecret), "dev-") {
		return nil, errors.New("development BOT_SESSION_SEED_SECRET is forbidden in production")
	}
	return cfg, nil
}

func loadDecisionLogEnv(cfg *AppConfig) error {
	var err error
	if raw := strings.TrimSpace(os.Getenv("BOT_DECISION_LOG_BATCH_SIZE")); raw != "" {
		cfg.DecisionLogBatchSize, err = strconv.Atoi(raw)
		if err != nil {
			return fmt.Errorf("BOT_DECISION_LOG_BATCH_SIZE must be an integer: %w", err)
		}
	}
	if raw := strings.TrimSpace(os.Getenv("BOT_DECISION_LOG_FLUSH_SECONDS")); raw != "" {
		seconds, parseErr := strconv.Atoi(raw)
		if parseErr != nil {
			return fmt.Errorf("BOT_DECISION_LOG_FLUSH_SECONDS must be an integer: %w", parseErr)
		}
		cfg.DecisionLogFlushInterval = time.Duration(seconds) * time.Second
	}
	if raw := strings.TrimSpace(os.Getenv("BOT_DECISION_HOLD_SAMPLE_RATE")); raw != "" {
		cfg.DecisionLogHoldSampleRate, err = strconv.ParseFloat(raw, 64)
		if err != nil {
			return fmt.Errorf("BOT_DECISION_HOLD_SAMPLE_RATE must be numeric: %w", err)
		}
	}
	if raw := strings.TrimSpace(os.Getenv("BOT_DECISION_LOG_RETENTION_SESSIONS")); raw != "" {
		cfg.DecisionLogRetentionSessions, err = strconv.Atoi(raw)
		if err != nil {
			return fmt.Errorf("BOT_DECISION_LOG_RETENTION_SESSIONS must be an integer: %w", err)
		}
	}
	if cfg.DecisionLogBatchSize < 100 || cfg.DecisionLogBatchSize > 500 {
		return errors.New("BOT_DECISION_LOG_BATCH_SIZE must be between 100 and 500")
	}
	if cfg.DecisionLogFlushInterval < time.Second || cfg.DecisionLogFlushInterval > 5*time.Second {
		return errors.New("BOT_DECISION_LOG_FLUSH_SECONDS must be between 1 and 5")
	}
	if cfg.DecisionLogHoldSampleRate < 0 || cfg.DecisionLogHoldSampleRate > 1 {
		return errors.New("BOT_DECISION_HOLD_SAMPLE_RATE must be in [0,1]")
	}
	if cfg.DecisionLogRetentionSessions <= 0 {
		return errors.New("BOT_DECISION_LOG_RETENTION_SESSIONS must be positive")
	}
	return nil
}

// ── Config Manager ────────────────────────────────────────────────────────────

// ConfigManager handles the Config Source of Truth precedence:
//  1. Compiled defaults (baked into binary)
//  2. YAML bootstrap file (bots.yaml — template only; does not overwrite existing bots)
//  3. DB persisted config (canonical runtime state)
//  4. Runtime override (persisted immediately to DB via UpdateConfig)
type ConfigManager struct {
	db *pgxpool.Pool
}

// NewConfigManager creates a ConfigManager backed by the given DB pool.
func NewConfigManager(db *pgxpool.Pool) *ConfigManager {
	return &ConfigManager{db: db}
}

// ReconcileYAML reads a YAML bootstrap file and inserts NEW bots only.
// IMPORTANT: It does NOT overwrite existing bots. Per PRD §0.3:
// "bots.yaml tidak boleh menimpa bot yang sudah ada saat restart."
// Perubahan massal terhadap bot existing hanya melalui operasi reconcile eksplisit.
func (m *ConfigManager) ReconcileYAML(ctx context.Context, path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil // No bootstrap file — that is fine
		}
		return err
	}

	var bots []BotConfig
	decoder := yaml.NewDecoder(strings.NewReader(string(data)))
	decoder.KnownFields(true)
	if err := decoder.Decode(&bots); err != nil {
		return fmt.Errorf("yaml parse error: %w", err)
	}
	if len(bots) == 0 {
		return errors.New("bootstrap config must contain at least one bot")
	}

	// Validate all bots before persisting any
	seen := make(map[string]struct{}, len(bots))
	for i, bot := range bots {
		normalized, err := NormalizeBotConfig(bot)
		if err != nil {
			return fmt.Errorf("bot %q invalid: %w", bot.ExternalBotID, err)
		}
		bots[i] = normalized
		if _, exists := seen[bot.ExternalBotID]; exists {
			return fmt.Errorf("duplicate external_bot_id %s", bot.ExternalBotID)
		}
		seen[bot.ExternalBotID] = struct{}{}
	}

	canonical, err := json.Marshal(bots)
	if err != nil {
		return err
	}
	hashBytes := sha256.Sum256(canonical)
	payloadHash := hex.EncodeToString(hashBytes[:])

	tx, err := m.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	var version int64
	err = tx.QueryRow(ctx, `
		INSERT INTO config_versions(version, description, config_data, source, payload_hash)
		VALUES ((SELECT COALESCE(MAX(version), 0) + 1 FROM config_versions), 'YAML bootstrap reconcile', $1, 'yaml', $2)
		ON CONFLICT(payload_hash) WHERE payload_hash IS NOT NULL DO UPDATE SET payload_hash=excluded.payload_hash
		RETURNING version
	`, canonical, payloadHash).Scan(&version)
	if err != nil {
		return err
	}

	for _, b := range bots {
		// INSERT only; DO NOTHING if bot already exists (per PRD §0.3)
		_, err := tx.Exec(ctx, `
			INSERT INTO bots (external_bot_id, strategy_type, config_version, status)
			VALUES ($1, $2, $3, 'inactive')
			ON CONFLICT (external_bot_id) DO NOTHING
		`, b.ExternalBotID, b.StrategyType, version)
		if err != nil {
			return err
		}
	}

	return tx.Commit(ctx)
}

// GetDBConfig loads the current persisted config for a bot from the DB.
// This is Layer 3 of the config precedence: DB config.
func (m *ConfigManager) GetDBConfig(ctx context.Context, externalBotID string) (*BotConfig, int64, error) {
	var strategyType string
	var configVersion int64
	var configData []byte
	err := m.db.QueryRow(ctx, `
		SELECT b.strategy_type, b.config_version, cv.config_data
		FROM bots b
		JOIN config_versions cv ON cv.version = b.config_version
		WHERE b.external_bot_id = $1
	`, externalBotID).Scan(&strategyType, &configVersion, &configData)
	if err != nil {
		return nil, 0, err
	}
	cfg := &BotConfig{
		ExternalBotID: externalBotID,
		StrategyType:  strategyType,
		Risk:          DefaultRiskConfig(),
		Human:         DefaultHumanConfig(),
		Activity:      DefaultActivityConfig(),
		ConfigVersion: configVersion,
	}
	var configs []BotConfig
	if err := json.Unmarshal(configData, &configs); err == nil {
		for _, candidate := range configs {
			if candidate.ExternalBotID == externalBotID {
				cfg = &candidate
				cfg.ConfigVersion = configVersion
				break
			}
		}
	} else {
		var candidate BotConfig
		if singleErr := json.Unmarshal(configData, &candidate); singleErr != nil {
			return nil, 0, fmt.Errorf("decode persisted config: %w", err)
		}
		if candidate.ExternalBotID == externalBotID {
			cfg = &candidate
			cfg.ConfigVersion = configVersion
		}
	}
	normalized, err := NormalizeBotConfig(*cfg)
	if err != nil {
		return nil, 0, fmt.Errorf("persisted config invalid: %w", err)
	}
	normalized.ConfigVersion = configVersion
	return &normalized, configVersion, nil
}

// UpdateConfig applies a runtime override for a bot. This is Layer 4: runtime override.
// It uses optimistic locking via expectedVersion to prevent concurrent conflicts (409).
// Per PRD §0.3: runtime overrides are persisted immediately to DB.
func (m *ConfigManager) UpdateConfig(ctx context.Context, externalBotID string, newConfig BotConfig, expectedVersion int64) error {
	newConfig.ExternalBotID = externalBotID
	normalized, err := NormalizeBotConfig(newConfig)
	if err != nil {
		return fmt.Errorf("config validation failed: %w", err)
	}
	newConfig = normalized

	canonical, err := json.Marshal(newConfig)
	if err != nil {
		return err
	}
	tx, err := m.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `LOCK TABLE config_versions IN EXCLUSIVE MODE`); err != nil {
		return err
	}
	var nextVersion int64
	err = tx.QueryRow(ctx, `
		INSERT INTO config_versions(version, description, config_data, source)
		VALUES ((SELECT COALESCE(MAX(version), 0) + 1 FROM config_versions),
		        'runtime override', $1, 'runtime')
		RETURNING version
	`, canonical).Scan(&nextVersion)
	if err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `
		UPDATE bots
		SET strategy_type = $1, config_version = $2, updated_at = NOW()
		WHERE external_bot_id = $3 AND config_version = $4
	`, newConfig.StrategyType, nextVersion, externalBotID, expectedVersion)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errors.New("optimistic lock failed: config_version mismatch or bot not found (409)")
	}
	return tx.Commit(ctx)
}
