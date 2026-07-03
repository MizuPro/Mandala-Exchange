package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"

	"github.com/jackc/pgx/v5/pgxpool"
)

func runCmd(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = os.Environ()
	return cmd.Run()
}

func main() {
	databaseURL := "postgres://mandala_bot:secret@localhost:5435/mandala_bot?sslmode=disable"
	ctx := context.Background()

	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		fmt.Printf("Error connecting to database: %v\n", err)
		os.Exit(1)
	}
	defer pool.Close()

	// Clear existing bots entirely to be clean
	fmt.Println("Clearing existing bots...")
	_, err = pool.Exec(ctx, "TRUNCATE bots, config_versions, bot_decision_logs, genesis_runs CASCADE;")
	if err != nil {
		fmt.Printf("Error clearing database: %v\n", err)
		os.Exit(1)
	}

	// 1. Provision 10 Noise Traders
	fmt.Println("Provisioning Noise Traders...")
	if err := runCmd("go", "run", "cmd/provision/main.go", "-count", "10", "-prefix", "noise"); err != nil {
		fmt.Printf("Error provisioning noise traders: %v\n", err)
		os.Exit(1)
	}

	// 2. Provision 5 Market Makers
	fmt.Println("Provisioning Market Makers...")
	if err := runCmd("go", "run", "cmd/provision/main.go", "-count", "5", "-prefix", "mm"); err != nil {
		fmt.Printf("Error provisioning market makers: %v\n", err)
		os.Exit(1)
	}
	// Update strategy type for MMs
	_, err = pool.Exec(ctx, "UPDATE bots SET strategy_type = 'market_maker' WHERE external_bot_id LIKE 'mm-%';")
	if err != nil {
		fmt.Printf("Error updating MM strategy type: %v\n", err)
		os.Exit(1)
	}

	// 3. Provision 5 Momentum Traders
	fmt.Println("Provisioning Momentum Traders...")
	if err := runCmd("go", "run", "cmd/provision/main.go", "-count", "5", "-prefix", "mom"); err != nil {
		fmt.Printf("Error provisioning momentum traders: %v\n", err)
		os.Exit(1)
	}
	// Update strategy type for Mom Traders
	_, err = pool.Exec(ctx, "UPDATE bots SET strategy_type = 'momentum_trader' WHERE external_bot_id LIKE 'mom-%';")
	if err != nil {
		fmt.Printf("Error updating Mom strategy type: %v\n", err)
		os.Exit(1)
	}

	// 4. Run Genesis
	fmt.Println("Running Genesis to seed cash and positions...")
	if err := runCmd("go", "run", "cmd/genesis/main.go"); err != nil {
		fmt.Printf("Error running genesis: %v\n", err)
		os.Exit(1)
	}

	fmt.Println("Successfully reset, provisioned, and seeded 20 bots (10 Noise, 5 MM, 5 Mom).")
}
