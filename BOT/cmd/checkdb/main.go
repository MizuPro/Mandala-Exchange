package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	databaseURL := os.Getenv("BOT_DATABASE_URL")
	if databaseURL == "" {
		log.Fatal("BOT_DATABASE_URL is required")
	}

	ctx := context.Background()
	dbPool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		log.Fatalf("Unable to connect to database: %v", err)
	}
	defer dbPool.Close()

	fmt.Println("--- bots ---")
	rows, err := dbPool.Query(ctx, "SELECT external_bot_id, strategy_type, status, config_version, sekuritas_account_id FROM bots")
	if err != nil {
		log.Fatal(err)
	}
	defer rows.Close()

	var count int
	for rows.Next() {
		count++
		var extID, strategy, status string
		var configVer *int64
		var accID *string
		if err := rows.Scan(&extID, &strategy, &status, &configVer, &accID); err != nil {
			log.Fatal(err)
		}
		verVal := int64(0)
		if configVer != nil {
			verVal = *configVer
		}
		accVal := "nil"
		if accID != nil {
			accVal = *accID
		}
		fmt.Printf("BotID: %s | Strat: %s | Status: %s | ConfigVer: %d | AccID: %s\n", extID, strategy, status, verVal, accVal)
	}
	fmt.Printf("Total bots in DB: %d\n\n", count)

	fmt.Println("--- config_versions ---")
	cvRows, err := dbPool.Query(ctx, "SELECT version, description, payload_hash, length(config_data::text) FROM config_versions")
	if err != nil {
		log.Fatal(err)
	}
	defer cvRows.Close()

	for cvRows.Next() {
		var ver int64
		var desc string
		var hash *string
		var length int
		if err := cvRows.Scan(&ver, &desc, &hash, &length); err != nil {
			log.Fatal(err)
		}
		hashVal := "nil"
		if hash != nil {
			hashVal = *hash
		}
		fmt.Printf("Version: %d | Desc: %s | Hash: %s | ConfigLength: %d\n", ver, desc, hashVal, length)
	}

	fmt.Println("\n--- bot_decision_logs ---")
	logRows, err := dbPool.Query(ctx, "SELECT action, client_order_id, symbol, decision_reason, reject_reason, context_snapshot, created_at FROM bot_decision_logs ORDER BY created_at DESC LIMIT 15")
	if err == nil {
		defer logRows.Close()
		for logRows.Next() {
			var action string
			var orderID, symbol, decReason, rejReason *string
			var ctxSnap []byte
			var createdAt time.Time
			if err := logRows.Scan(&action, &orderID, &symbol, &decReason, &rejReason, &ctxSnap, &createdAt); err == nil {
				ordVal := "nil"
				if orderID != nil {
					ordVal = *orderID
				}
				symVal := "nil"
				if symbol != nil {
					symVal = *symbol
				}
				decVal := "nil"
				if decReason != nil {
					decVal = *decReason
				}
				rejVal := "nil"
				if rejReason != nil {
					rejVal = *rejReason
				}
				snapVal := "{}"
				if len(ctxSnap) > 0 {
					snapVal = string(ctxSnap)
				}
				fmt.Printf("[%s] Action: %s | Symbol: %s | Reason: %s | Rej: %s | Snap: %s | OrderID: %s\n", 
					createdAt.Local().Format("15:04:05"), action, symVal, decVal, rejVal, snapVal, ordVal)
			} else {
				log.Printf("Scan error: %v", err)
			}
		}
	} else {
		log.Printf("Query error: %v", err)
	}
}
