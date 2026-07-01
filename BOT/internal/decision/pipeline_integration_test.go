package decision

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPostgresPipelineInsertRedactionAndRetention(t *testing.T) {
	databaseURL := os.Getenv("BOT_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("BOT_TEST_DATABASE_URL is required for PostgreSQL integration")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()

	internalID := uuid.New()
	externalID := "decision-test-" + internalID.String()
	if _, err := pool.Exec(ctx, `
		INSERT INTO bots (internal_id, external_bot_id, strategy_type, status)
		VALUES ($1, $2, 'noise_trader', 'active')`,
		internalID, externalID,
	); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM bots WHERE internal_id = $1`, internalID)
	})

	cfg := testConfig()
	cfg.RetentionSessions = 30
	cfg.HoldSampleRate = 1
	pipeline, err := NewPipeline(pool, cfg)
	if err != nil {
		t.Fatal(err)
	}

	for i := 0; i < 31; i++ {
		sessionID := uuid.New()
		if err := pipeline.Record(ctx, DecisionLog{
			InternalID: &internalID, SessionInstanceID: &sessionID,
			VirtualDayIndex: ptr(int64(i + 1)), Strategy: "noise_trader",
			Symbol: "BBCA", SessionStatus: "continuous", Action: ActionPlaceOrder,
			DecisionReason: "integration_test",
			ContextSnapshot: map[string]interface{}{
				"nested": map[string]interface{}{"service_token": "must-not-persist"},
			},
			OrderSubmitted: true,
		}); err != nil {
			t.Fatal(err)
		}
	}
	pipeline.Close()

	var count int
	var contextJSON []byte
	if err := pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM bot_decision_logs WHERE internal_id = $1`, internalID,
	).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 31 {
		t.Fatalf("expected 31 inserted logs, got %d", count)
	}
	if err := pool.QueryRow(ctx, `
		SELECT context_snapshot FROM bot_decision_logs
		WHERE internal_id = $1 ORDER BY created_at DESC LIMIT 1`, internalID,
	).Scan(&contextJSON); err != nil {
		t.Fatal(err)
	}
	var snapshot map[string]interface{}
	if err := json.Unmarshal(contextJSON, &snapshot); err != nil {
		t.Fatal(err)
	}
	nested := snapshot["nested"].(map[string]interface{})
	if nested["service_token"] == "must-not-persist" {
		t.Fatal("secret persisted without redaction")
	}

	cleanupPipeline, err := NewPipeline(pool, cfg)
	if err != nil {
		t.Fatal(err)
	}
	affected, err := cleanupPipeline.CleanupOldLogs(ctx)
	cleanupPipeline.Close()
	if err != nil {
		t.Fatal(err)
	}
	if affected < 1 {
		t.Fatalf("expected at least one old session log to be deleted, affected=%d", affected)
	}
	if err := pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM bot_decision_logs WHERE internal_id = $1`, internalID,
	).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count >= 31 {
		t.Fatalf("retention did not remove old sessions, remaining=%d", count)
	}
}
