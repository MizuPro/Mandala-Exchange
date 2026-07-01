package risk

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrVersionConflict = errors.New("risk state version conflict")

type PostgresRepository struct {
	ctx context.Context
	db  *pgxpool.Pool
}

func NewPostgresRepository(ctx context.Context, db *pgxpool.Pool) *PostgresRepository {
	return &PostgresRepository{ctx: ctx, db: db}
}

func (r *PostgresRepository) Load(botID string) (State, error) {
	var s State
	err := r.db.QueryRow(r.ctx, `
		SELECT bot_id, account_id, status, COALESCE(session_instance_id::text, ''),
		       virtual_day_index, daily_baseline_idr, weekly_baseline_idr,
		       week_start_day_index, last_equity_idr, disabled_reason, version
		FROM bot_risk_state WHERE bot_id = $1`, botID).Scan(
		&s.BotID, &s.AccountID, &s.Status, &s.SessionInstanceID, &s.VirtualDayIndex,
		&s.DailyBaselineIDR, &s.WeeklyBaselineIDR, &s.WeekStartDayIndex,
		&s.LastEquityIDR, &s.DisabledReason, &s.Version,
	)
	return s, err
}

func (r *PostgresRepository) Save(previousVersion int64, s State) (State, error) {
	return r.save(previousVersion, s, false)
}

func (r *PostgresRepository) MarkBankrupt(previousVersion int64, s State) (State, error) {
	return r.save(previousVersion, s, true)
}

func (r *PostgresRepository) save(previousVersion int64, s State, bankrupt bool) (State, error) {
	tx, err := r.db.Begin(r.ctx)
	if err != nil {
		return State{}, err
	}
	defer tx.Rollback(r.ctx)
	if s.Status == StatusDisabled {
		tag, updateErr := tx.Exec(r.ctx, `
			UPDATE bots SET status = 'disabled', updated_at = NOW()
			WHERE external_bot_id = $1 AND status NOT IN ('disabled', 'bankrupt')`, s.BotID)
		if updateErr != nil {
			return State{}, updateErr
		}
		if tag.RowsAffected() == 0 {
			var status string
			if err := tx.QueryRow(r.ctx, `SELECT status FROM bots WHERE external_bot_id=$1`, s.BotID).Scan(&status); err != nil {
				return State{}, err
			}
			if status != "disabled" {
				return State{}, fmt.Errorf("bot %s cannot transition to disabled", s.BotID)
			}
		}
	}
	if bankrupt {
		tag, updateErr := tx.Exec(r.ctx, `
			UPDATE bots SET status = 'bankrupt', updated_at = NOW()
			WHERE external_bot_id = $1 AND status <> 'bankrupt'`, s.BotID)
		if updateErr != nil {
			return State{}, updateErr
		}
		if tag.RowsAffected() == 0 {
			var status string
			if err := tx.QueryRow(r.ctx, `SELECT status FROM bots WHERE external_bot_id=$1`, s.BotID).Scan(&status); err != nil {
				return State{}, err
			}
			if status != "bankrupt" {
				return State{}, fmt.Errorf("bot %s cannot transition to bankrupt", s.BotID)
			}
		}
	}
	var session any
	if s.SessionInstanceID != "" {
		session = s.SessionInstanceID
	}
	row := tx.QueryRow(r.ctx, `
		INSERT INTO bot_risk_state (
			bot_id, account_id, status, session_instance_id, virtual_day_index,
			daily_baseline_idr, weekly_baseline_idr, week_start_day_index,
			last_equity_idr, disabled_reason, version, updated_at
		) VALUES ($1,$2,$3,$4::uuid,$5,$6,$7,$8,$9,$10,1,NOW())
		ON CONFLICT (bot_id) DO UPDATE SET
			account_id=EXCLUDED.account_id, status=EXCLUDED.status,
			session_instance_id=EXCLUDED.session_instance_id,
			virtual_day_index=EXCLUDED.virtual_day_index,
			daily_baseline_idr=EXCLUDED.daily_baseline_idr,
			weekly_baseline_idr=EXCLUDED.weekly_baseline_idr,
			week_start_day_index=EXCLUDED.week_start_day_index,
			last_equity_idr=EXCLUDED.last_equity_idr,
			disabled_reason=EXCLUDED.disabled_reason,
			version=bot_risk_state.version+1, updated_at=NOW()
		WHERE bot_risk_state.version=$11
		RETURNING version`,
		s.BotID, s.AccountID, s.Status, session, s.VirtualDayIndex,
		s.DailyBaselineIDR, s.WeeklyBaselineIDR, s.WeekStartDayIndex,
		s.LastEquityIDR, s.DisabledReason, previousVersion,
	)
	if err := row.Scan(&s.Version); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return State{}, ErrVersionConflict
		}
		return State{}, err
	}
	if err := tx.Commit(r.ctx); err != nil {
		return State{}, err
	}
	return s, nil
}
