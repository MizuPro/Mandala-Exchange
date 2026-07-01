package sentiment

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPostgresRepositoryVersionOverrideAndRecovery(t *testing.T) {
	databaseURL := os.Getenv("BOT_LIVE_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("BOT_LIVE_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)

	// Isolate the optimistic global version sequence while retaining real
	// PostgreSQL constraints and SQL execution. Rollback leaves no test rows.
	if _, err := tx.Exec(ctx, `LOCK TABLE market_sentiment IN EXCLUSIVE MODE`); err != nil {
		t.Fatal(err)
	}
	repository := &PostgresRepository{db: tx}
	service := NewService(repository)
	if err := service.Load(ctx); err != nil {
		t.Fatal(err)
	}
	sessionID := uuid.New()
	base, err := service.EnsureSession(ctx, sessionID)
	if err != nil {
		t.Fatal(err)
	}
	override, err := service.SetOverride(ctx, State{
		SessionInstanceID: sessionID,
		Overall:           Bearish, VolatilityRegime: VolatilityHigh,
		SectorSentiment: map[string]SectorTone{"finance": SectorNegative},
		ValidUntil:      time.Now().Add(time.Minute), Source: "integration_test",
	}, base.Version)
	if err != nil {
		t.Fatal(err)
	}
	restarted := NewService(repository)
	if err := restarted.Load(ctx); err != nil {
		t.Fatal(err)
	}
	current, err := restarted.Current(time.Now())
	if err != nil || current.Version != override.Version ||
		current.SectorSentiment["FINANCE"] != SectorNegative {
		t.Fatalf("repository recovery mismatch: %+v, %v", current, err)
	}
}
