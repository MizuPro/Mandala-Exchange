package strategystate

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Repository interface {
	LoadLatest(context.Context) ([]Snapshot, error)
	Save(context.Context, Snapshot) (Snapshot, error)
}

type PostgresRepository struct {
	db *pgxpool.Pool
}

func NewPostgresRepository(db *pgxpool.Pool) *PostgresRepository {
	return &PostgresRepository{db: db}
}

func (r *PostgresRepository) LoadLatest(ctx context.Context) ([]Snapshot, error) {
	rows, err := r.db.Query(ctx, `
		SELECT b.external_bot_id, b.strategy_type, s.state_version,
		       s.session_instance_id, s.snapshot_data, s.checkpoint,
		       s.snapshot_reason, s.created_at
		FROM bots b
		JOIN LATERAL (
			SELECT state_version, session_instance_id, snapshot_data,
			       checkpoint, snapshot_reason, created_at
			FROM state_snapshots
			WHERE internal_id = b.internal_id
			  AND strategy_type = b.strategy_type
			ORDER BY state_version DESC
			LIMIT 1
		) s ON TRUE
		WHERE b.strategy_type IN ('bandar', 'value_investor', 'index_tracker')
		  AND b.status NOT IN ('disabled', 'bankrupt')
		ORDER BY b.external_bot_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var snapshots []Snapshot
	for rows.Next() {
		var snapshot Snapshot
		var sessionID *uuid.UUID
		var checkpointJSON []byte
		if err := rows.Scan(
			&snapshot.BotID, &snapshot.Strategy, &snapshot.StateVersion,
			&sessionID, &snapshot.State, &checkpointJSON,
			&snapshot.Reason, &snapshot.CreatedAt,
		); err != nil {
			return nil, err
		}
		if sessionID != nil {
			snapshot.SessionInstanceID = *sessionID
		}
		if err := json.Unmarshal(checkpointJSON, &snapshot.Checkpoint); err != nil {
			return nil, fmt.Errorf("decode checkpoint for bot %s: %w", snapshot.BotID, err)
		}
		snapshots = append(snapshots, clone(snapshot))
	}
	return snapshots, rows.Err()
}

func (r *PostgresRepository) Save(ctx context.Context, snapshot Snapshot) (Snapshot, error) {
	if err := snapshot.Validate(); err != nil {
		return Snapshot{}, err
	}
	checkpoint, err := json.Marshal(snapshot.Checkpoint)
	if err != nil {
		return Snapshot{}, err
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return Snapshot{}, err
	}
	defer tx.Rollback(ctx)

	nextVersion := snapshot.StateVersion + 1
	var internalID uuid.UUID
	err = tx.QueryRow(ctx, `
		UPDATE bots
		SET strategy_state_version = $1, updated_at = NOW()
		WHERE external_bot_id = $2
		  AND strategy_type = $3
		  AND strategy_state_version = $4
		  AND status NOT IN ('disabled', 'bankrupt')
		RETURNING internal_id`,
		nextVersion, snapshot.BotID, snapshot.Strategy, snapshot.StateVersion,
	).Scan(&internalID)
	if errors.Is(err, pgx.ErrNoRows) {
		var exists bool
		lookupErr := tx.QueryRow(ctx,
			`SELECT EXISTS(SELECT 1 FROM bots WHERE external_bot_id = $1)`,
			snapshot.BotID,
		).Scan(&exists)
		if lookupErr != nil {
			return Snapshot{}, lookupErr
		}
		if !exists {
			return Snapshot{}, ErrNotFound
		}
		return Snapshot{}, ErrVersionConflict
	}
	if err != nil {
		return Snapshot{}, err
	}

	var sessionID any
	if snapshot.SessionInstanceID != uuid.Nil {
		sessionID = snapshot.SessionInstanceID
	}
	err = tx.QueryRow(ctx, `
		INSERT INTO state_snapshots(
			internal_id, state_version, snapshot_data, strategy_type,
			session_instance_id, checkpoint, snapshot_reason, created_at
		) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
		RETURNING created_at`,
		internalID, nextVersion, snapshot.State, snapshot.Strategy,
		sessionID, checkpoint, snapshot.Reason,
	).Scan(&snapshot.CreatedAt)
	if err != nil {
		return Snapshot{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Snapshot{}, err
	}
	snapshot.StateVersion = nextVersion
	return clone(snapshot), nil
}
