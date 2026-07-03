package main

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"

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
	file, err := os.Open(".env.development")
	if err != nil {
		fmt.Printf("Error opening .env: %v\n", err)
		os.Exit(1)
	}
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		if len(parts) == 2 {
			os.Setenv(parts[0], parts[1])
		}
	}
	file.Close()

	databaseURL := os.Getenv("BOT_DATABASE_URL")
	ctx := context.Background()

	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		fmt.Printf("Error connecting to database: %v\n", err)
		os.Exit(1)
	}
	defer pool.Close()

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

	fmt.Println("Successfully provisioned and seeded 20 bots (10 Noise, 5 MM, 5 Mom).")
}
