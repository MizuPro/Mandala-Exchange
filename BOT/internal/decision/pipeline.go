package decision

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Mandala-Exchange/BOT/internal/logger"
)

const (
	DefaultBatchSize        = 500
	DefaultFlushInterval    = 5 * time.Second
	DefaultHoldSampleRate   = 0.02
	DefaultRetainSessions   = 30
	MinimumBatchSize        = 100
	MaximumBatchSize        = 500
	MinimumFlushInterval    = time.Second
	MaximumFlushInterval    = 5 * time.Second
	defaultBufferMultiplier = 5
)

var (
	ErrClosed = errors.New("decision log pipeline is closed")
	ErrFull   = errors.New("decision log HOLD buffer is full")
)

type LogAction string

const (
	ActionPlaceOrder   LogAction = "place_order"
	ActionCancel       LogAction = "cancel"
	ActionAmend        LogAction = "amend"
	ActionReject       LogAction = "reject"
	ActionRiskHalt     LogAction = "risk_halt"
	ActionBreaker      LogAction = "breaker"
	ActionHold         LogAction = "hold"
	ActionExpiredQueue LogAction = "expired_before_submit"
)

type Config struct {
	BatchSize         int
	FlushInterval     time.Duration
	HoldSampleRate    float64
	RetentionSessions int
	BufferCapacity    int
}

func DefaultConfig() Config {
	return Config{
		BatchSize:         DefaultBatchSize,
		FlushInterval:     DefaultFlushInterval,
		HoldSampleRate:    DefaultHoldSampleRate,
		RetentionSessions: DefaultRetainSessions,
		BufferCapacity:    DefaultBatchSize * defaultBufferMultiplier,
	}
}

func (c Config) Validate() error {
	if c.BatchSize < MinimumBatchSize || c.BatchSize > MaximumBatchSize {
		return fmt.Errorf("decision log batch size must be between %d and %d", MinimumBatchSize, MaximumBatchSize)
	}
	if c.FlushInterval < MinimumFlushInterval || c.FlushInterval > MaximumFlushInterval {
		return fmt.Errorf("decision log flush interval must be between %s and %s", MinimumFlushInterval, MaximumFlushInterval)
	}
	if c.HoldSampleRate < 0 || c.HoldSampleRate > 1 {
		return errors.New("decision log HOLD sample rate must be in [0,1]")
	}
	if c.RetentionSessions <= 0 {
		return errors.New("decision log retention sessions must be positive")
	}
	if c.BufferCapacity < c.BatchSize {
		return errors.New("decision log buffer capacity must be at least the batch size")
	}
	return nil
}

// DecisionLog is the private, admin-audited record defined by BOT_PRD section 8.1.
// InternalID is nil for global breaker/lifecycle decisions.
type DecisionLog struct {
	InternalID        *uuid.UUID
	SimulationRunID   *uuid.UUID
	SessionInstanceID *uuid.UUID
	VirtualDayIndex   *int64
	Strategy          string
	Symbol            string
	SessionStatus     string
	Action            LogAction
	DecisionReason    string
	ContextSnapshot   map[string]interface{}
	OrderSubmitted    bool
	ClientOrderID     *string
	SekuritasOrderID  *string
	OrderPriceIDR     *int64
	OrderQuantity     *int64
	OrderStatus       *string
	RejectReason      *string
	CreatedAt         time.Time
}

type store interface {
	Insert(context.Context, []DecisionLog) error
	Cleanup(context.Context, int) (int64, error)
}

type postgresStore struct{ db *pgxpool.Pool }

type Pipeline struct {
	store          store
	cfg            Config
	logChan        chan DecisionLog
	ctx            context.Context
	cancel         context.CancelFunc
	done           chan struct{}
	closeOnce      sync.Once
	mu             sync.RWMutex
	closed         bool
	shutdownCtx    context.Context
	terminalErr    error
	sample         func() float64
	sampledOutHold atomic.Uint64
	fullHoldDrops  atomic.Uint64
}

func NewPipeline(db *pgxpool.Pool, cfg Config) (*Pipeline, error) {
	if db == nil {
		return nil, errors.New("decision log database pool is required")
	}
	return newPipeline(&postgresStore{db: db}, cfg, rand.Float64)
}

func newPipeline(s store, cfg Config, sample func() float64) (*Pipeline, error) {
	if s == nil {
		return nil, errors.New("decision log store is required")
	}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	if sample == nil {
		return nil, errors.New("decision log sampler is required")
	}

	ctx, cancel := context.WithCancel(context.Background())
	p := &Pipeline{
		store:   s,
		cfg:     cfg,
		logChan: make(chan DecisionLog, cfg.BufferCapacity),
		ctx:     ctx,
		cancel:  cancel,
		done:    make(chan struct{}),
		sample:  sample,
	}
	go p.worker()
	return p, nil
}

// Record queues a decision. Material decisions apply backpressure instead of
// being silently discarded. Sampled HOLD records may be dropped when the
// bounded buffer is full because HOLD itself is explicitly sampled.
func (p *Pipeline) Record(ctx context.Context, entry DecisionLog) error {
	if ctx == nil {
		return errors.New("decision log context is required")
	}
	if entry.Action == "" {
		return errors.New("decision log action is required")
	}
	if entry.Action == ActionHold && p.sample() >= p.cfg.HoldSampleRate {
		p.sampledOutHold.Add(1)
		return nil
	}
	entry.ContextSnapshot = logger.RedactSecretFields(entry.ContextSnapshot)
	if entry.CreatedAt.IsZero() {
		entry.CreatedAt = time.Now().UTC()
	}

	p.mu.RLock()
	defer p.mu.RUnlock()
	if p.closed {
		return ErrClosed
	}
	if entry.Action == ActionHold {
		select {
		case p.logChan <- entry:
			return nil
		default:
			p.fullHoldDrops.Add(1)
			return ErrFull
		}
	}
	select {
	case p.logChan <- entry:
		return nil
	case <-ctx.Done():
		return fmt.Errorf("queue material decision log: %w", ctx.Err())
	}
}

func (p *Pipeline) worker() {
	defer close(p.done)
	ticker := time.NewTicker(p.cfg.FlushInterval)
	defer ticker.Stop()

	buffer := make([]DecisionLog, 0, p.cfg.BatchSize)
	flush := func(ctx context.Context) bool {
		if len(buffer) == 0 {
			return true
		}
		if err := p.store.Insert(ctx, buffer); err != nil {
			logger.Error("Failed to flush decision logs; batch retained for retry", map[string]interface{}{
				"error": err.Error(), "count": len(buffer),
			})
			return false
		}
		buffer = buffer[:0]
		return true
	}

	for {
		select {
		case entry := <-p.logChan:
			buffer = append(buffer, entry)
			if len(buffer) >= p.cfg.BatchSize {
				flush(p.ctx)
			}
		case <-ticker.C:
			flush(p.ctx)
		case <-p.ctx.Done():
			for {
				select {
				case entry := <-p.logChan:
					buffer = append(buffer, entry)
				default:
					p.mu.RLock()
					shutdownCtx := p.shutdownCtx
					p.mu.RUnlock()
					p.terminalErr = flushUntilContext(shutdownCtx, buffer, p.store)
					return
				}
			}
		}
	}
}

func flushUntilContext(ctx context.Context, logs []DecisionLog, s store) error {
	for len(logs) > 0 {
		attemptCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		err := s.Insert(attemptCtx, logs)
		cancel()
		if err == nil {
			return nil
		}
		logger.Error("Decision log shutdown flush failed; retrying", map[string]interface{}{
			"error": err.Error(), "count": len(logs),
		})
		select {
		case <-ctx.Done():
			return fmt.Errorf("flush decision logs during shutdown: %w", ctx.Err())
		case <-time.After(100 * time.Millisecond):
		}
	}
	return nil
}

func (p *Pipeline) CleanupOldLogs(ctx context.Context) (int64, error) {
	return p.store.Cleanup(ctx, p.cfg.RetentionSessions)
}

// Close stops new records, drains the complete channel, and durably flushes all
// accepted material decisions before returning.
func (p *Pipeline) Close() {
	_ = p.CloseContext(context.Background())
}

// CloseContext bounds the shutdown flush. It reports a durability failure
// instead of hanging service shutdown forever when PostgreSQL is unavailable.
func (p *Pipeline) CloseContext(ctx context.Context) error {
	if ctx == nil {
		return errors.New("decision log shutdown context is required")
	}
	p.closeOnce.Do(func() {
		p.mu.Lock()
		p.closed = true
		p.shutdownCtx = ctx
		p.mu.Unlock()
		p.cancel()
	})
	select {
	case <-p.done:
		return p.terminalErr
	case <-ctx.Done():
		return fmt.Errorf("wait for decision log shutdown: %w", ctx.Err())
	}
}

func (s *postgresStore) Insert(ctx context.Context, logs []DecisionLog) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	rows := make([][]interface{}, 0, len(logs))
	for _, entry := range logs {
		var contextJSON []byte
		if entry.ContextSnapshot != nil {
			contextJSON, err = json.Marshal(entry.ContextSnapshot)
			if err != nil {
				return fmt.Errorf("marshal decision context: %w", err)
			}
		}
		rows = append(rows, []interface{}{
			entry.InternalID, entry.SimulationRunID, entry.SessionInstanceID,
			entry.VirtualDayIndex, entry.Strategy, entry.Symbol, entry.SessionStatus,
			string(entry.Action), entry.DecisionReason, contextJSON,
			entry.OrderSubmitted, entry.ClientOrderID, entry.SekuritasOrderID,
			entry.OrderPriceIDR, entry.OrderQuantity, entry.OrderStatus,
			entry.RejectReason, entry.CreatedAt,
		})
	}
	_, err = tx.CopyFrom(ctx, pgx.Identifier{"bot_decision_logs"}, []string{
		"internal_id", "simulation_run_id", "session_instance_id",
		"virtual_day_index", "strategy", "symbol", "session_status",
		"action", "decision_reason", "context_snapshot",
		"order_submitted", "client_order_id", "sekuritas_order_id",
		"order_price_idr", "order_quantity_shares", "order_status",
		"reject_reason", "created_at",
	}, pgx.CopyFromRows(rows))
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *postgresStore) Cleanup(ctx context.Context, retainSessions int) (int64, error) {
	tag, err := s.db.Exec(ctx, `
		WITH retained AS (
			SELECT session_instance_id
			FROM bot_decision_logs
			WHERE session_instance_id IS NOT NULL
			GROUP BY session_instance_id
			ORDER BY MAX(created_at) DESC
			LIMIT $1
		)
		DELETE FROM bot_decision_logs
		WHERE session_instance_id IS NOT NULL
		  AND session_instance_id NOT IN (SELECT session_instance_id FROM retained)`,
		retainSessions,
	)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
