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

	rows, err := pool.Query(ctx, "SELECT session_status, strategy, action, decision_reason, count(*) FROM bot_decision_logs GROUP BY session_status, strategy, action, decision_reason ORDER BY count DESC LIMIT 50;")
	if err != nil {
		fmt.Printf("Error querying tables: %v\n", err)
		os.Exit(1)
	}
	defer rows.Close()

	for rows.Next() {
		var status, strategy, action, reason string
		var count int
		if err := rows.Scan(&status, &strategy, &action, &reason, &count); err != nil {
			fmt.Println(err)
			continue
		}
		fmt.Printf("Status: %s, Strategy: %s, Action: %s, Reason: %s, Count: %d\n", status, strategy, action, reason, count)
	}
}
