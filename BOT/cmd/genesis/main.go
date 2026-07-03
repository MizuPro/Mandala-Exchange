package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"os"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Mandala-Exchange/BOT/internal/client/sekuritas"
	"github.com/Mandala-Exchange/BOT/internal/config"
)

type genesisAccountPayload struct {
	ExternalBotID string                  `json:"external_bot_id"`
	AccountID     string                  `json:"account_id"`
	CashIDR       int64                   `json:"cash_idr"`
	Positions     []genesisPositionPayload `json:"positions"`
}

type genesisPositionPayload struct {
	Symbol           string `json:"symbol"`
	QuantityShares   int64  `json:"quantity_shares"`
	AveragePriceIDR  int64  `json:"average_price_idr"`
}

type genesisRequest struct {
	GenesisRunID string                  `json:"genesis_run_id"`
	Accounts     []genesisAccountPayload `json:"accounts"`
}

func main() {
	databaseURL := os.Getenv("BOT_DATABASE_URL")
	baseURL := os.Getenv("SEKURITAS_BASE_URL")
	token := os.Getenv("BOT_SERVICE_TOKEN")

	if databaseURL == "" || baseURL == "" || token == "" {
		log.Fatal("BOT_DATABASE_URL, SEKURITAS_BASE_URL, and BOT_SERVICE_TOKEN environment variables are required")
	}

	ctx := context.Background()

	// 1. Koneksi ke Database Lokal BOT
	dbPool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		log.Fatalf("Unable to connect to database: %v", err)
	}
	defer dbPool.Close()

	// 2. Ambil Semua Bot Terdaftar yang memiliki sekuritas_account_id
	rows, err := dbPool.Query(ctx, 
		`SELECT external_bot_id, sekuritas_account_id::text, strategy_type FROM bots 
		 WHERE sekuritas_account_id IS NOT NULL AND status != 'disabled'`)
	if err != nil {
		log.Fatalf("Failed to fetch registered bots: %v", err)
	}
	defer rows.Close()

	var accounts []genesisAccountPayload
	var botConfigs []config.BotConfig
	var botIDs []string

	for rows.Next() {
		var botID, accountID, strategyType string
		if err := rows.Scan(&botID, &accountID, &strategyType); err != nil {
			log.Fatalf("Failed to scan bot row: %v", err)
		}

		botIDs = append(botIDs, botID)

		// Seeding awal per Bot:
		// - Cash: 100,000,000 IDR (100 juta)
		// - Saham BARA: 10 lot (1,000 lembar) @ 190
		// - Saham NUSA: 10 lot (1,000 lembar) @ 735
		accounts = append(accounts, genesisAccountPayload{
			ExternalBotID: botID,
			AccountID:     accountID,
			CashIDR:       100000000, 
			Positions: []genesisPositionPayload{
				{Symbol: "BARA", QuantityShares: 1000, AveragePriceIDR: 190},
				{Symbol: "NUSA", QuantityShares: 1000, AveragePriceIDR: 735},
			},
		})

		// Bangun parameter default sesuai strategy
		var params map[string]interface{}
		
		if strategyType == "market_maker" {
			params = map[string]interface{}{
				"symbols_universe":        map[string]interface{}{"type": "all_active"},
				"levels":                  3,
				"spread_ticks":            config.Distribution{Type: "uniform", Min: 2, Max: 6},
				"level_size_lots":         config.Distribution{Type: "uniform", Min: 5, Max: 25},
				"refresh_virtual_seconds": config.Distribution{Type: "uniform", Min: 20, Max: 45},
				"max_inventory_lots":      100,
				"inventory_skew_strength": 0.50,
				"fee_aware":               true,
				"self_trade_prevention":   "cancel_newest",
			}
		} else if strategyType == "momentum_trader" {
			params = map[string]interface{}{
				"decision_interval_virtual_minutes": config.Distribution{Type: "uniform", Min: 1, Max: 5},
				"lookback_virtual_minutes":          config.Distribution{Type: "uniform", Min: 10, Max: 30},
				"buy_trigger_pct":                   config.Distribution{Type: "normal", Mean: 0.015, StdDev: 0.004, Min: 0.007, Max: 0.028, Clamp: true},
				"sell_trigger_pct":                  config.Distribution{Type: "normal", Mean: -0.015, StdDev: 0.004, Min: -0.028, Max: -0.007, Clamp: true},
				"confirmation": map[string]interface{}{
					"minimum_trade_count":                 3,
					"minimum_persistence_virtual_seconds": 15,
					"require_volume_signal_probability":   0.70,
				},
				"entry_hysteresis_pct":      0.003,
				"cooldown_virtual_minutes":  config.Distribution{Type: "uniform", Min: 10, Max: 40},
				"take_profit_pct":           0.03,
				"stop_loss_pct":             0.02,
				"order_size_lots":           config.Distribution{Type: "uniform", Min: 5, Max: 20},
				"symbols_universe":          map[string]interface{}{"type": "all_active"},
			}
		} else {
			// default to noise_trader
			strategyType = "noise_trader"
			params = map[string]interface{}{
				"decision_interval_virtual_minutes": config.Distribution{Type: "uniform", Min: 1, Max: 3},
				"order_size_lots":                  config.Distribution{Type: "uniform", Min: 1, Max: 3},
				"buy_probability":                 0.50,
				"max_price_deviation_pct":         0.02,
				"cancel_probability":              0.30,
				"cancel_after_virtual_minutes":      config.Distribution{Type: "uniform", Min: 3, Max: 8},
				"symbols_universe":                  map[string]interface{}{"type": "all_active"},
			}
		}

		botConfigs = append(botConfigs, config.BotConfig{
			ExternalBotID: botID,
			StrategyType:  strategyType,
			Risk:          config.DefaultRiskConfig(),
			Human:         config.DefaultHumanConfig(),
			Activity:      config.DefaultActivityConfig(),
			Parameters:    params,
		})
	}

	if len(accounts) == 0 {
		log.Println("No bots found in database to seed. Please run provisioning first.")
		return
	}

	log.Printf("Preparing config seeding and genesis payload for %d bots...", len(accounts))

	// ── SEED CONFIGURATION ──
	configBytes, err := json.Marshal(botConfigs)
	if err != nil {
		log.Fatalf("Failed to marshal bot configs: %v", err)
	}

	configHash := sha256.Sum256(configBytes)
	payloadHashStr := hex.EncodeToString(configHash[:32])

	tx, err := dbPool.Begin(ctx)
	if err != nil {
		log.Fatalf("Failed to begin transaction for config: %v", err)
	}
	defer tx.Rollback(ctx)

	// Cek apakah payload_hash sudah ada di DB
	var actualVersion int64
	err = tx.QueryRow(ctx, `SELECT version FROM config_versions WHERE payload_hash = $1`, payloadHashStr).Scan(&actualVersion)
	if err != nil {
		// Jika belum ada, masukkan data baru
		actualVersion = time.Now().UnixNano()
		_, err = tx.Exec(ctx,
			`INSERT INTO config_versions (version, description, config_data, source, payload_hash)
			 VALUES ($1, 'Bootstrap Genesis Config', $2, 'database', $3)`,
			actualVersion, configBytes, payloadHashStr)
		if err != nil {
			log.Fatalf("Failed to insert config version: %v", err)
		}
	} else {
		// Jika sudah ada, update datanya agar sinkron
		_, err = tx.Exec(ctx,
			`UPDATE config_versions SET config_data = $1 WHERE version = $2`,
			configBytes, actualVersion)
		if err != nil {
			log.Fatalf("Failed to update config version: %v", err)
		}
	}

	// Update bots untuk mereferensikan config version tersebut
	for _, botID := range botIDs {
		_, err = tx.Exec(ctx, `UPDATE bots SET config_version = $1 WHERE external_bot_id = $2`, actualVersion, botID)
		if err != nil {
			log.Fatalf("Failed to bind bot to config version: %v", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		log.Fatalf("Failed to commit config database transaction: %v", err)
	}
	log.Printf("Successfully seeded config versions and linked %d bots to config version: %d", len(botIDs), actualVersion)

	// ── TRIGGER GENESIS SAGA ──
	genesisRunID := uuid.New().String()
	payload := genesisRequest{
		GenesisRunID: genesisRunID,
		Accounts:     accounts,
	}

	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		log.Fatalf("Failed to marshal genesis payload: %v", err)
	}
	hash := sha256.Sum256(payloadBytes)
	idempotencyKey := "genesis-" + hex.EncodeToString(hash[:16])

	client := sekuritas.NewClient(baseURL, token)
	log.Printf("Triggering genesis on Sekuritas (run ID: %s)...", genesisRunID)
	err = client.TriggerGenesis(ctx, payload, idempotencyKey)
	if err != nil {
		log.Fatalf("Genesis triggering failed on Sekuritas: %v", err)
	}
	log.Println("Genesis successfully completed on Sekuritas & BEI Custody!")

	// ── PERSIST LOCAL GENESIS RUN & UPDATE BOTS TO ACTIVE ──
	txGen, err := dbPool.Begin(ctx)
	if err != nil {
		log.Fatalf("Failed to begin transaction for genesis: %v", err)
	}
	defer txGen.Rollback(ctx)

	_, err = txGen.Exec(ctx, 
		`INSERT INTO genesis_runs (genesis_run_id, status, completed_at) 
		 VALUES ($1, 'completed', $2) 
		 ON CONFLICT (genesis_run_id) DO UPDATE SET status = 'completed', completed_at = $2`, 
		genesisRunID, time.Now())
	if err != nil {
		log.Fatalf("Failed to insert completed genesis run: %v", err)
	}

	_, err = txGen.Exec(ctx, `UPDATE bots SET status = 'active' WHERE sekuritas_account_id IS NOT NULL AND status = 'inactive'`)
	if err != nil {
		log.Fatalf("Failed to update bots status to active: %v", err)
	}

	if err := txGen.Commit(ctx); err != nil {
		log.Fatalf("Failed to commit genesis database transaction: %v", err)
	}

	log.Printf("Genesis completed! Local database updated with genesis run ID: %s. All bots are now set to 'active'.", genesisRunID)
}
