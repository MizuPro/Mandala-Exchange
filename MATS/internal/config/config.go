package config

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type ServiceToken struct {
	Name   string   `json:"name"`
	Token  string   `json:"token"`
	Scopes []string `json:"scopes"`
}

type Config struct {
	AppEnv                string
	HTTPAddr              string
	DatabaseURL           string
	ServiceTokens         []ServiceToken
	BEIBaseURL            string
	BEIServiceToken       string
	SekuritasEventsURL    string
	SekuritasServiceToken string
	SessionID             string
	SyncInterval          time.Duration
	DeliveryMaxAttempts   int
	RedisURL              string
}

func Load() (Config, error) {
	cfg := Config{
		AppEnv:                getEnv("APP_ENV", "development"),
		HTTPAddr:              getEnv("MATS_HTTP_ADDR", ":8082"),
		DatabaseURL:           getEnv("MATS_DATABASE_URL", ""),
		BEIBaseURL:            getEnv("BEI_BASE_URL", "http://localhost:4100/v1"),
		BEIServiceToken:       getEnv("BEI_SERVICE_TOKEN", ""),
		SekuritasEventsURL:    getEnv("SEKURITAS_EVENTS_URL", ""),
		SekuritasServiceToken: getEnv("SEKURITAS_SERVICE_TOKEN", ""),
		SessionID:             getEnv("MATS_SESSION_ID", "local-session"),
		SyncInterval:          time.Duration(getEnvInt("MATS_SYNC_INTERVAL_SECONDS", 60)) * time.Second,
		DeliveryMaxAttempts:   getEnvInt("MATS_DELIVERY_MAX_ATTEMPTS", 5),
		RedisURL:              getEnv("REDIS_URL", "redis://localhost:6379"),
	}

	rawTokens := getEnv("MATS_SERVICE_TOKENS", "[]")
	if err := json.Unmarshal([]byte(rawTokens), &cfg.ServiceTokens); err != nil {
		return Config{}, fmt.Errorf("parse MATS_SERVICE_TOKENS: %w", err)
	}

	if cfg.AppEnv == "production" {
		if err := validateProduction(cfg); err != nil {
			return Config{}, err
		}
	}

	return cfg, nil
}

func validateProduction(cfg Config) error {
	var errors []string
	if cfg.DatabaseURL == "" {
		errors = append(errors, "MATS_DATABASE_URL is required in production")
	}
	if containsAny(cfg.DatabaseURL, []string{"localhost:5434/mandala_mats", "/mandala_mats?"}) {
		errors = append(errors, "MATS_DATABASE_URL must not point to the development database in production")
	}
	for _, token := range cfg.ServiceTokens {
		if weakProductionSecret(token.Token) {
			errors = append(errors, "MATS_SERVICE_TOKENS."+token.Name+" must use a strong production token")
		}
	}
	if weakProductionSecret(cfg.BEIServiceToken) {
		errors = append(errors, "BEI_SERVICE_TOKEN must use a strong production token")
	}
	if weakProductionSecret(cfg.SekuritasServiceToken) {
		errors = append(errors, "SEKURITAS_SERVICE_TOKEN must use a strong production token")
	}
	if len(errors) > 0 {
		return fmt.Errorf("invalid MATS production environment: %v", errors)
	}
	return nil
}

func weakProductionSecret(value string) bool {
	if len(value) < 32 {
		return true
	}
	return containsAny(value, []string{"change-me", "replace-with", "dev-", "local-"})
}

func containsAny(value string, needles []string) bool {
	for _, needle := range needles {
		if len(needle) > 0 && contains(value, needle) {
			return true
		}
	}
	return false
}

func contains(value string, needle string) bool {
	return strings.Contains(value, needle)
}

func getEnv(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func getEnvInt(key string, fallback int) int {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}
