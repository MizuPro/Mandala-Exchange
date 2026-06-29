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
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
	"gopkg.in/yaml.v3"
)

type BotConfig struct {
	ExternalBotID string                 `yaml:"external_bot_id"`
	StrategyType  string                 `yaml:"strategy_type"`
	Parameters    map[string]interface{} `yaml:"parameters"`
}

type AppConfig struct {
	AppEnv           string
	HTTPAddr         string
	DatabaseURL      string
	RedisURL         string
	SekuritasBaseURL string
	MatsWSURL        string
	BeiBaseURL       string
	ServiceToken     string
}

func LoadEnv() (*AppConfig, error) {
	cfg := &AppConfig{
		AppEnv:           os.Getenv("APP_ENV"),
		HTTPAddr:         os.Getenv("BOT_HTTP_ADDR"),
		DatabaseURL:      os.Getenv("BOT_DATABASE_URL"),
		RedisURL:         os.Getenv("REDIS_URL"),
		SekuritasBaseURL: os.Getenv("SEKURITAS_BASE_URL"),
		MatsWSURL:        os.Getenv("MATS_WS_URL"),
		BeiBaseURL:       os.Getenv("BEI_BASE_URL"),
		ServiceToken:     os.Getenv("BOT_SERVICE_TOKEN"),
	}
	var missing []string
	for name, value := range map[string]string{
		"APP_ENV": cfg.AppEnv, "BOT_HTTP_ADDR": cfg.HTTPAddr, "BOT_DATABASE_URL": cfg.DatabaseURL,
		"REDIS_URL": cfg.RedisURL, "SEKURITAS_BASE_URL": cfg.SekuritasBaseURL,
		"MATS_WS_URL": cfg.MatsWSURL, "BEI_BASE_URL": cfg.BeiBaseURL, "BOT_SERVICE_TOKEN": cfg.ServiceToken,
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
	for name, value := range map[string]string{"BOT_DATABASE_URL": cfg.DatabaseURL, "REDIS_URL": cfg.RedisURL, "SEKURITAS_BASE_URL": cfg.SekuritasBaseURL, "MATS_WS_URL": cfg.MatsWSURL, "BEI_BASE_URL": cfg.BeiBaseURL} {
		if _, err := url.ParseRequestURI(value); err != nil {
			return nil, fmt.Errorf("%s is invalid: %w", name, err)
		}
	}
	if cfg.AppEnv == "production" && strings.Contains(strings.ToLower(cfg.ServiceToken), "dev-") {
		return nil, errors.New("development BOT_SERVICE_TOKEN is forbidden in production")
	}
	return cfg, nil
}

type ConfigManager struct {
	db *pgxpool.Pool
}

func NewConfigManager(db *pgxpool.Pool) *ConfigManager {
	return &ConfigManager{db: db}
}

func (m *ConfigManager) ReconcileYAML(ctx context.Context, path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil // No bootstrap file
		}
		return err
	}

	var bots []BotConfig
	decoder := yaml.NewDecoder(strings.NewReader(string(data)))
	decoder.KnownFields(true)
	if err := decoder.Decode(&bots); err != nil {
		return err
	}
	if len(bots) == 0 {
		return errors.New("bootstrap config must contain at least one bot")
	}
	seen := make(map[string]struct{}, len(bots))
	for _, bot := range bots {
		if bot.ExternalBotID == "" || bot.StrategyType == "" {
			return errors.New("external_bot_id and strategy_type are required")
		}
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
		_, err := tx.Exec(ctx, `
			INSERT INTO bots (external_bot_id, strategy_type, config_version, status)
			VALUES ($1, $2, $3, 'inactive')
			ON CONFLICT (external_bot_id) DO UPDATE SET
			  strategy_type=excluded.strategy_type,
			  config_version=excluded.config_version,
			  updated_at=now()
		`, b.ExternalBotID, b.StrategyType, version)
		if err != nil {
			return err
		}
	}

	return tx.Commit(ctx)
}

func (m *ConfigManager) UpdateConfig(ctx context.Context, externalBotID string, newConfig BotConfig, expectedVersion int64) error {
	// Optimistic locking implementation
	tag, err := m.db.Exec(ctx, `
		UPDATE bots 
		SET strategy_type = $1, config_version = $2, updated_at = NOW()
		WHERE external_bot_id = $3 AND config_version = $4
	`, newConfig.StrategyType, expectedVersion+1, externalBotID, expectedVersion)

	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errors.New("optimistic lock failed or bot not found")
	}
	return nil
}
