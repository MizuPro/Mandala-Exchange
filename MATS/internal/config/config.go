package config

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"time"
)

type ServiceToken struct {
	Name   string   `json:"name"`
	Token  string   `json:"token"`
	Scopes []string `json:"scopes"`
}

type Config struct {
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
}

func Load() (Config, error) {
	cfg := Config{
		HTTPAddr:              getEnv("MATS_HTTP_ADDR", ":8082"),
		DatabaseURL:           getEnv("MATS_DATABASE_URL", ""),
		BEIBaseURL:            getEnv("BEI_BASE_URL", "http://localhost:3001/v1"),
		BEIServiceToken:       getEnv("BEI_SERVICE_TOKEN", ""),
		SekuritasEventsURL:    getEnv("SEKURITAS_EVENTS_URL", ""),
		SekuritasServiceToken: getEnv("SEKURITAS_SERVICE_TOKEN", ""),
		SessionID:             getEnv("MATS_SESSION_ID", "local-session"),
		SyncInterval:          time.Duration(getEnvInt("MATS_SYNC_INTERVAL_SECONDS", 60)) * time.Second,
		DeliveryMaxAttempts:   getEnvInt("MATS_DELIVERY_MAX_ATTEMPTS", 5),
	}

	rawTokens := getEnv("MATS_SERVICE_TOKENS", "[]")
	if err := json.Unmarshal([]byte(rawTokens), &cfg.ServiceTokens); err != nil {
		return Config{}, fmt.Errorf("parse MATS_SERVICE_TOKENS: %w", err)
	}

	return cfg, nil
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
