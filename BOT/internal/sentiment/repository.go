package sentiment

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type database interface {
	QueryRow(context.Context, string, ...any) pgx.Row
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

type PostgresRepository struct {
	db database
}

func NewPostgresRepository(_ context.Context, db *pgxpool.Pool) *PostgresRepository {
	return &PostgresRepository{db: db}
}

func (r *PostgresRepository) LoadLatest(ctx context.Context) (*State, *State, error) {
	base, err := r.loadOne(ctx, false)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, err
	}
	override, overrideErr := r.loadOne(ctx, true)
	if overrideErr != nil && !errors.Is(overrideErr, pgx.ErrNoRows) {
		return nil, nil, overrideErr
	}
	return base, override, nil
}

func (r *PostgresRepository) loadOne(ctx context.Context, override bool) (*State, error) {
	var state State
	var sessionID *uuid.UUID
	var sectors []byte
	var validUntil *time.Time
	err := r.db.QueryRow(ctx, `
		SELECT version, session_instance_id, overall, volatility_regime,
		       sector_sentiment, is_override, valid_until, source, created_at
		FROM market_sentiment
		WHERE is_override = $1
		ORDER BY version DESC LIMIT 1
	`, override).Scan(
		&state.Version, &sessionID, &state.Overall, &state.VolatilityRegime,
		&sectors, &state.IsOverride, &validUntil, &state.Source, &state.CreatedAt,
	)
	if err != nil {
		return nil, err
	}
	if sessionID != nil {
		state.SessionInstanceID = *sessionID
	}
	if validUntil != nil {
		state.ValidUntil = *validUntil
	}
	if err := json.Unmarshal(sectors, &state.SectorSentiment); err != nil {
		return nil, err
	}
	return &state, nil
}

func (r *PostgresRepository) Append(ctx context.Context, state State, expectedVersion int64) error {
	sectors, err := json.Marshal(cloneSectors(state.SectorSentiment))
	if err != nil {
		return err
	}
	var sessionID any
	if state.SessionInstanceID != uuid.Nil {
		sessionID = state.SessionInstanceID
	}
	var validUntil any
	if !state.ValidUntil.IsZero() {
		validUntil = state.ValidUntil
	}
	tag, err := r.db.Exec(ctx, `
		INSERT INTO market_sentiment(
		  version, session_instance_id, overall, volatility_regime,
		  sector_sentiment, is_override, valid_until, source, created_at
		)
		SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9
		WHERE COALESCE((SELECT MAX(version) FROM market_sentiment), 0) = $10
		ON CONFLICT (version) DO NOTHING
	`, state.Version, sessionID, state.Overall, state.VolatilityRegime,
		sectors, state.IsOverride, validUntil, state.Source, state.CreatedAt, expectedVersion)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrVersionConflict
	}
	return nil
}
