package sequence

import (
	"context"
	"sync/atomic"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Generator interface {
	Next(context.Context) (int64, error)
}

type AtomicGenerator struct {
	value atomic.Int64
}

func NewAtomic(start int64) *AtomicGenerator {
	generator := &AtomicGenerator{}
	generator.value.Store(start)
	return generator
}

func (g *AtomicGenerator) Next(context.Context) (int64, error) {
	return g.value.Add(1), nil
}

type PostgresGenerator struct {
	pool *pgxpool.Pool
}

func NewPostgres(pool *pgxpool.Pool) *PostgresGenerator {
	return &PostgresGenerator{pool: pool}
}

func (g *PostgresGenerator) Next(ctx context.Context) (int64, error) {
	var value int64
	err := g.pool.QueryRow(ctx, "SELECT nextval('mats_event_sequence')").Scan(&value)
	return value, err
}
