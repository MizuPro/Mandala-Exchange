package main

import (
	"context"
	"fmt"
	"os"

	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	databaseURL := "postgres://mandala_mats:mandala_mats@localhost:5434/mandala_mats?sslmode=disable"
	ctx := context.Background()

	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		fmt.Printf("Error connecting to MATS database: %v\n", err)
		os.Exit(1)
	}
	defer pool.Close()

	_, err = pool.Exec(ctx, "DELETE FROM bots WHERE bot_id LIKE 'e2e-%';")
	if err != nil {
		fmt.Printf("Error deleting E2E bots from MATS: %v\n", err)
		os.Exit(1)
	}

	botDB := "postgres://mandala_bot:secret@localhost:5435/mandala_bot?sslmode=disable"
	botPool, err := pgxpool.New(ctx, botDB)
	if err != nil {
		fmt.Printf("Error connecting to BOT database: %v\n", err)
		os.Exit(1)
	}
	defer botPool.Close()

	_, err = botPool.Exec(ctx, "DELETE FROM bots WHERE external_bot_id LIKE 'e2e-%';")
	if err != nil {
		fmt.Printf("Error deleting E2E bots from BOT: %v\n", err)
		os.Exit(1)
	}

	fmt.Println("Successfully cleaned up all E2E phantom bots from MATS and BOT databases.")
}
