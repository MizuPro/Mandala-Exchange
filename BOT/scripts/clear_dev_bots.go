package main

import (
	"context"
	"fmt"
	"os"

	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	databaseURL := "postgres://mandala_bot:secret@localhost:5435/mandala_bot?sslmode=disable"
	ctx := context.Background()

	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		fmt.Printf("Error connecting to database: %v\n", err)
		os.Exit(1)
	}
	defer pool.Close()

	if err := pool.Ping(ctx); err != nil {
		fmt.Printf("Error pinging database: %v\n", err)
		os.Exit(1)
	}

	_, err = pool.Exec(ctx, "TRUNCATE bots, config_versions, bot_decision_logs CASCADE;")
	if err != nil {
		fmt.Printf("Error truncating tables: %v\n", err)
		os.Exit(1)
	}

	fmt.Println("Successfully cleared bot configuration and instances from development database.")
}
