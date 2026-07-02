package deterministic

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PostgresRepository struct{ db *pgxpool.Pool }

func NewPostgresRepository(db *pgxpool.Pool) *PostgresRepository {
	return &PostgresRepository{db: db}
}

func (p *PostgresRepository) Create(ctx context.Context, run Run) error {
	tx, err := p.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	_, err = tx.Exec(ctx, `INSERT INTO simulation_runs
		(run_id,mode,global_seed,config_snapshot,virtual_time,status,model_version)
		VALUES($1,$2,$3,$4,$5,'running',$6)`,
		run.ID, run.Mode, run.GlobalSeed, run.ConfigSnapshot, run.VirtualTime, run.ModelVersion)
	if err != nil {
		return err
	}
	for botID, seed := range run.BotSeeds {
		if _, err = tx.Exec(ctx, `INSERT INTO simulation_bot_seeds(run_id,bot_id,seed) VALUES($1,$2,$3)`,
			run.ID, botID, seed); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (p *PostgresRepository) Append(ctx context.Context, runID uuid.UUID, entry Entry) error {
	_, err := p.db.Exec(ctx, `INSERT INTO simulation_journal
		(run_id,sequence,kind,event_sequence,virtual_time,bot_id,payload)
		VALUES($1,$2,$3,$4,$5,NULLIF($6,''),$7)`,
		runID, entry.Sequence, entry.Kind, entry.EventSequence, entry.VirtualTime, entry.BotID, entry.Payload)
	return err
}

func (p *PostgresRepository) Load(ctx context.Context, runID uuid.UUID) (Run, []Entry, error) {
	var run Run
	run.ID = runID
	err := p.db.QueryRow(ctx, `SELECT mode,global_seed,config_snapshot,virtual_time,status,model_version
		FROM simulation_runs WHERE run_id=$1`, runID).Scan(
		&run.Mode, &run.GlobalSeed, &run.ConfigSnapshot, &run.VirtualTime, &run.Status, &run.ModelVersion)
	if err != nil {
		return Run{}, nil, err
	}
	run.BotSeeds = map[string]int64{}
	seedRows, err := p.db.Query(ctx, `SELECT bot_id,seed FROM simulation_bot_seeds WHERE run_id=$1`, runID)
	if err != nil {
		return Run{}, nil, err
	}
	defer seedRows.Close()
	for seedRows.Next() {
		var id string
		var seed int64
		if err := seedRows.Scan(&id, &seed); err != nil {
			return Run{}, nil, err
		}
		run.BotSeeds[id] = seed
	}
	rows, err := p.db.Query(ctx, `SELECT sequence,kind,event_sequence,virtual_time,COALESCE(bot_id,''),payload
		FROM simulation_journal WHERE run_id=$1 ORDER BY sequence`, runID)
	if err != nil {
		return Run{}, nil, err
	}
	defer rows.Close()
	var entries []Entry
	for rows.Next() {
		var entry Entry
		if err := rows.Scan(&entry.Sequence, &entry.Kind, &entry.EventSequence,
			&entry.VirtualTime, &entry.BotID, &entry.Payload); err != nil {
			return Run{}, nil, err
		}
		entries = append(entries, entry)
	}
	return run, entries, rows.Err()
}

func (p *PostgresRepository) Complete(ctx context.Context, runID uuid.UUID, virtualTime time.Time) error {
	_, err := p.db.Exec(ctx, `UPDATE simulation_runs SET status='completed',virtual_time=$2,ended_at=NOW()
		WHERE run_id=$1 AND status='running'`, runID, virtualTime)
	return err
}
