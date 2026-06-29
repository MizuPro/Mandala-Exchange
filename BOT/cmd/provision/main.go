package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"fmt"
	"log"
	"os"

	"github.com/Mandala-Exchange/BOT/internal/client/sekuritas"
	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	count := flag.Int("count", 10, "number of BOT accounts to provision")
	prefix := flag.String("prefix", "noise", "stable external BOT ID prefix")
	flag.Parse()
	if *count < 1 || *count > 100 {
		log.Fatal("count must be between 1 and 100")
	}
	databaseURL := os.Getenv("BOT_DATABASE_URL")
	baseURL := os.Getenv("SEKURITAS_BASE_URL")
	token := os.Getenv("BOT_SERVICE_TOKEN")
	if databaseURL == "" || baseURL == "" || token == "" {
		log.Fatal("BOT_DATABASE_URL, SEKURITAS_BASE_URL, and BOT_SERVICE_TOKEN are required")
	}

	request := sekuritas.ProvisionBatchRequest{Bots: make([]sekuritas.ProvisionBotRequest, 0, *count)}
	for i := 1; i <= *count; i++ {
		id := fmt.Sprintf("%s-%04d", *prefix, i)
		request.Bots = append(request.Bots, sekuritas.ProvisionBotRequest{
			ExternalBotID: id, Email: id + "@bot.internal", DisplayName: id,
			Tier: "retail", Strategy: "noise_trader",
		})
	}
	hash := sha256.Sum256([]byte(fmt.Sprintf("%v", request.Bots)))
	idempotencyKey := "provision-" + hex.EncodeToString(hash[:16])
	ctx := context.Background()
	client := sekuritas.NewClient(baseURL, token)
	response, err := client.ProvisionBots(ctx, request, idempotencyKey)
	if err != nil {
		log.Fatal(err)
	}
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		log.Fatal(err)
	}
	defer pool.Close()
	tx, err := pool.Begin(ctx)
	if err != nil {
		log.Fatal(err)
	}
	defer tx.Rollback(ctx)
	for _, result := range response.Results {
		if result.Status == "failed" || result.AccountID == "" {
			log.Fatalf("provision failed for %s", result.ExternalBotID)
		}
		_, err = tx.Exec(ctx, `
			INSERT INTO bots(external_bot_id, strategy_type, status, sekuritas_account_id)
			VALUES ($1, 'noise_trader', 'inactive', $2)
			ON CONFLICT(external_bot_id) DO UPDATE
			SET sekuritas_account_id=excluded.sekuritas_account_id, updated_at=now()
		`, result.ExternalBotID, result.AccountID)
		if err != nil {
			log.Fatal(err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		log.Fatal(err)
	}
	log.Printf("provisioned/reconciled %d BOT accounts", len(response.Results))
}
