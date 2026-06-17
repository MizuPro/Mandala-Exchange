package persistence

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"mandala-exchange/mats/internal/domain"
)

var ErrNotFound = errors.New("not found")

type Event struct {
	ID             string
	SequenceNumber int64
	EventType      string
	OrderID        string
	TradeID        string
	Symbol         string
	Payload        any
	CreatedAt      time.Time
}

type DeliveryEvent struct {
	ID             string
	SequenceNumber int64
	Target         string
	EventType      string
	CorrelationID  string
	Symbol         string
	Payload        any
	Attempts       int
	MaxAttempts    int
	Status         string
	LastError      string
	NextAttemptAt  time.Time
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

type IdempotencyRecord struct {
	Key         string
	Operation   string
	ResourceID  string
	RequestHash string
	Response    json.RawMessage
	CreatedAt   time.Time
}

type Store interface {
	Ping(context.Context) error
	SaveOrder(context.Context, *domain.Order) error
	UpdateOrder(context.Context, *domain.Order) error
	FindOrderByID(context.Context, string) (*domain.Order, error)
	FindOrderByIdempotency(context.Context, string) (*domain.Order, error)
	SaveIdempotencyRecord(context.Context, IdempotencyRecord) error
	FindIdempotencyRecord(context.Context, string) (*IdempotencyRecord, error)
	LoadOpenOrders(context.Context) ([]*domain.Order, error)
	SaveTrade(context.Context, *domain.Trade) error
	CountSessionTrades(context.Context, string) (int, error)
	FindTradesByOrderID(context.Context, string) ([]domain.Trade, error)
	AppendEvent(context.Context, Event) error
	SaveDeliveryEvent(context.Context, DeliveryEvent) error
	UpdateDeliveryEvent(context.Context, DeliveryEvent) error
	LoadDueDeliveryEvents(context.Context, int) ([]DeliveryEvent, error)
	ListDeliveryEvents(context.Context, string, int) ([]DeliveryEvent, error)
	RequeueDeadDeliveryEvent(context.Context, string) (*DeliveryEvent, error)
}

type PostgresStore struct {
	pool *pgxpool.Pool
}

func NewPostgresStore(pool *pgxpool.Pool) *PostgresStore {
	return &PostgresStore{pool: pool}
}

func Connect(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return pool, nil
}

func (s *PostgresStore) Ping(ctx context.Context) error {
	return s.pool.Ping(ctx)
}

func (s *PostgresStore) SaveOrder(ctx context.Context, order *domain.Order) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO mats_orders (
			id, client_order_id, broker_code, account_id, symbol, side, order_type, price,
			original_quantity, remaining_quantity, filled_quantity, status, reject_reason,
			idempotency_key, sequence_number, correlation_id, created_at, updated_at
		)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NULLIF($13,''),$14,$15,NULLIF($16,''),$17,$18)
		ON CONFLICT (id) DO UPDATE SET
			remaining_quantity = EXCLUDED.remaining_quantity,
			filled_quantity = EXCLUDED.filled_quantity,
			status = EXCLUDED.status,
			reject_reason = EXCLUDED.reject_reason,
			updated_at = EXCLUDED.updated_at
	`, order.ID, order.ClientOrderID, order.BrokerCode, order.AccountID, order.Symbol, order.Side, order.OrderType,
		order.Price, order.OriginalQuantity, order.RemainingQuantity, order.FilledQuantity, order.Status,
		order.RejectReason, order.IdempotencyKey, order.SequenceNumber, order.CorrelationID, order.CreatedAt, order.UpdatedAt)
	return err
}

func (s *PostgresStore) UpdateOrder(ctx context.Context, order *domain.Order) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE mats_orders
		SET price = $2,
		    original_quantity = $3,
		    remaining_quantity = $4,
		    filled_quantity = $5,
		    status = $6,
		    reject_reason = NULLIF($7, ''),
		    updated_at = $8
		WHERE id = $1
	`, order.ID, order.Price, order.OriginalQuantity, order.RemainingQuantity, order.FilledQuantity, order.Status, order.RejectReason, order.UpdatedAt)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *PostgresStore) FindOrderByID(ctx context.Context, id string) (*domain.Order, error) {
	return scanOrder(s.pool.QueryRow(ctx, orderSelectSQL()+" WHERE id = $1", id))
}

func (s *PostgresStore) FindOrderByIdempotency(ctx context.Context, key string) (*domain.Order, error) {
	return scanOrder(s.pool.QueryRow(ctx, orderSelectSQL()+" WHERE idempotency_key = $1", key))
}

func (s *PostgresStore) SaveIdempotencyRecord(ctx context.Context, record IdempotencyRecord) error {
	if record.CreatedAt.IsZero() {
		record.CreatedAt = time.Now().UTC()
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO mats_idempotency_records (
			idempotency_key, operation, resource_id, request_hash, response, created_at
		)
		VALUES ($1,$2,$3,$4,$5,$6)
		ON CONFLICT (idempotency_key) DO NOTHING
	`, record.Key, record.Operation, record.ResourceID, record.RequestHash, record.Response, record.CreatedAt)
	return err
}

func (s *PostgresStore) FindIdempotencyRecord(ctx context.Context, key string) (*IdempotencyRecord, error) {
	var record IdempotencyRecord
	err := s.pool.QueryRow(ctx, `
		SELECT idempotency_key, operation, resource_id, COALESCE(request_hash, ''), response, created_at
		FROM mats_idempotency_records
		WHERE idempotency_key = $1
	`, key).Scan(&record.Key, &record.Operation, &record.ResourceID, &record.RequestHash, &record.Response, &record.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &record, nil
}

func (s *PostgresStore) LoadOpenOrders(ctx context.Context) ([]*domain.Order, error) {
	rows, err := s.pool.Query(ctx, orderSelectSQL()+`
		WHERE status IN ('open', 'partially_filled', 'amended')
		  AND remaining_quantity > 0
		ORDER BY sequence_number
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var orders []*domain.Order
	for rows.Next() {
		order, err := scanOrder(rows)
		if err != nil {
			return nil, err
		}
		orders = append(orders, order)
	}
	return orders, rows.Err()
}

func (s *PostgresStore) SaveTrade(ctx context.Context, trade *domain.Trade) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO mats_trades (
			id, sequence_number, session_id, symbol, price, quantity, buy_order_id, sell_order_id,
			buy_broker_code, sell_broker_code, buy_account_id, sell_account_id, occurred_at, idempotency_key
		)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
		ON CONFLICT (id) DO NOTHING
	`, trade.ID, trade.SequenceNumber, trade.SessionID, trade.Symbol, trade.Price, trade.Quantity,
		trade.BuyOrderID, trade.SellOrderID, trade.BuyBrokerCode, trade.SellBrokerCode,
		trade.BuyAccountID, trade.SellAccountID, trade.OccurredAt, trade.IdempotencyKey)
	return err
}

func (s *PostgresStore) CountSessionTrades(ctx context.Context, sessionID string) (int, error) {
	var count int
	err := s.pool.QueryRow(ctx, `SELECT COUNT(*) FROM mats_trades WHERE session_id = $1`, sessionID).Scan(&count)
	return count, err
}

func (s *PostgresStore) FindTradesByOrderID(ctx context.Context, orderID string) ([]domain.Trade, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, sequence_number, session_id, symbol, price::text, quantity::text, buy_order_id, sell_order_id,
		       buy_broker_code, sell_broker_code, buy_account_id, sell_account_id, occurred_at, idempotency_key
		FROM mats_trades
		WHERE buy_order_id = $1 OR sell_order_id = $1
		ORDER BY sequence_number
	`, orderID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var trades []domain.Trade
	for rows.Next() {
		var trade domain.Trade
		var price, quantity string
		if err := rows.Scan(
			&trade.ID, &trade.SequenceNumber, &trade.SessionID, &trade.Symbol, &price, &quantity,
			&trade.BuyOrderID, &trade.SellOrderID, &trade.BuyBrokerCode, &trade.SellBrokerCode,
			&trade.BuyAccountID, &trade.SellAccountID, &trade.OccurredAt, &trade.IdempotencyKey,
		); err != nil {
			return nil, err
		}
		var parseErr error
		if trade.Price, parseErr = parseNumericInt(price); parseErr != nil {
			return nil, fmt.Errorf("parse trade price: %w", parseErr)
		}
		if trade.Quantity, parseErr = parseNumericInt(quantity); parseErr != nil {
			return nil, fmt.Errorf("parse trade quantity: %w", parseErr)
		}
		trades = append(trades, trade)
	}
	return trades, rows.Err()
}

func (s *PostgresStore) AppendEvent(ctx context.Context, event Event) error {
	payload, err := json.Marshal(event.Payload)
	if err != nil {
		return err
	}
	createdAt := event.CreatedAt
	if createdAt.IsZero() {
		createdAt = time.Now().UTC()
	}
	_, err = s.pool.Exec(ctx, `
		INSERT INTO mats_order_events (
			id, sequence_number, event_type, order_id, trade_id, symbol, payload, created_at
		)
		VALUES ($1,$2,$3,NULLIF($4,''),NULLIF($5,''),NULLIF($6,''),$7,$8)
	`, event.ID, event.SequenceNumber, event.EventType, event.OrderID, event.TradeID, event.Symbol, payload, createdAt)
	return err
}

func (s *PostgresStore) SaveDeliveryEvent(ctx context.Context, event DeliveryEvent) error {
	payload, err := json.Marshal(event.Payload)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	if event.CreatedAt.IsZero() {
		event.CreatedAt = now
	}
	if event.UpdatedAt.IsZero() {
		event.UpdatedAt = now
	}
	if event.NextAttemptAt.IsZero() {
		event.NextAttemptAt = now
	}
	if event.Status == "" {
		event.Status = "pending"
	}
	if event.MaxAttempts <= 0 {
		event.MaxAttempts = 5
	}
	_, err = s.pool.Exec(ctx, `
		INSERT INTO mats_delivery_events (
			id, sequence_number, target, event_type, correlation_id, symbol, payload,
			attempts, max_attempts, status, last_error, next_attempt_at, created_at, updated_at
		)
		VALUES ($1,$2,$3,$4,NULLIF($5,''),NULLIF($6,''),$7,$8,$9,$10,NULLIF($11,''),$12,$13,$14)
		ON CONFLICT (id) DO NOTHING
	`, event.ID, event.SequenceNumber, event.Target, event.EventType, event.CorrelationID, event.Symbol, payload,
		event.Attempts, event.MaxAttempts, event.Status, event.LastError, event.NextAttemptAt, event.CreatedAt, event.UpdatedAt)
	return err
}

func (s *PostgresStore) UpdateDeliveryEvent(ctx context.Context, event DeliveryEvent) error {
	payload, err := json.Marshal(event.Payload)
	if err != nil {
		return err
	}
	event.UpdatedAt = time.Now().UTC()
	tag, err := s.pool.Exec(ctx, `
		UPDATE mats_delivery_events
		SET payload = $2,
		    attempts = $3,
		    status = $4,
		    last_error = NULLIF($5, ''),
		    next_attempt_at = $6,
		    updated_at = $7
		WHERE id = $1
	`, event.ID, payload, event.Attempts, event.Status, event.LastError, event.NextAttemptAt, event.UpdatedAt)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *PostgresStore) LoadDueDeliveryEvents(ctx context.Context, limit int) ([]DeliveryEvent, error) {
	if limit <= 0 {
		limit = 100
	}
	rows, err := s.pool.Query(ctx, `
		SELECT id, sequence_number, target, event_type, COALESCE(correlation_id, ''), COALESCE(symbol, ''),
		       payload, attempts, max_attempts, status, COALESCE(last_error, ''), next_attempt_at, created_at, updated_at
		FROM mats_delivery_events
		WHERE status = 'pending' AND next_attempt_at <= now()
		ORDER BY sequence_number
		LIMIT $1
	`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	return scanDeliveryEvents(rows)
}

func (s *PostgresStore) ListDeliveryEvents(ctx context.Context, status string, limit int) ([]DeliveryEvent, error) {
	if limit <= 0 {
		limit = 100
	}
	query := `
		SELECT id, sequence_number, target, event_type, COALESCE(correlation_id, ''), COALESCE(symbol, ''),
		       payload, attempts, max_attempts, status, COALESCE(last_error, ''), next_attempt_at, created_at, updated_at
		FROM mats_delivery_events
	`
	args := []any{}
	if status != "" {
		query += " WHERE status = $1"
		args = append(args, status)
	}
	query += fmt.Sprintf(" ORDER BY sequence_number DESC LIMIT $%d", len(args)+1)
	args = append(args, limit)
	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanDeliveryEvents(rows)
}

func (s *PostgresStore) RequeueDeadDeliveryEvent(ctx context.Context, eventID string) (*DeliveryEvent, error) {
	now := time.Now().UTC()
	tag, err := s.pool.Exec(ctx, `
		UPDATE mats_delivery_events
		SET status = 'pending',
		    last_error = NULL,
		    next_attempt_at = $2,
		    max_attempts = max_attempts + 3,
		    updated_at = $2
		WHERE id = $1 AND status = 'dead'
	`, eventID, now)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, ErrNotFound
	}
	rows, err := s.pool.Query(ctx, `
		SELECT id, sequence_number, target, event_type, COALESCE(correlation_id, ''), COALESCE(symbol, ''),
		       payload, attempts, max_attempts, status, COALESCE(last_error, ''), next_attempt_at, created_at, updated_at
		FROM mats_delivery_events
		WHERE id = $1
	`, eventID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	events, err := scanDeliveryEvents(rows)
	if err != nil {
		return nil, err
	}
	if len(events) == 0 {
		return nil, ErrNotFound
	}
	return &events[0], nil
}

type deliveryRows interface {
	Next() bool
	Scan(dest ...any) error
	Err() error
}

func scanDeliveryEvents(rows deliveryRows) ([]DeliveryEvent, error) {
	var events []DeliveryEvent
	for rows.Next() {
		var event DeliveryEvent
		var rawPayload []byte
		if err := rows.Scan(&event.ID, &event.SequenceNumber, &event.Target, &event.EventType, &event.CorrelationID, &event.Symbol,
			&rawPayload, &event.Attempts, &event.MaxAttempts, &event.Status, &event.LastError, &event.NextAttemptAt, &event.CreatedAt, &event.UpdatedAt); err != nil {
			return nil, err
		}
		var payload any
		if err := json.Unmarshal(rawPayload, &payload); err != nil {
			return nil, err
		}
		event.Payload = payload
		events = append(events, event)
	}
	return events, rows.Err()
}

type rowScanner interface {
	Scan(dest ...any) error
}

func orderSelectSQL() string {
	return `
		SELECT id, client_order_id, broker_code, account_id, symbol, side, order_type,
		       price::text, original_quantity::text, remaining_quantity::text, filled_quantity::text,
		       status, COALESCE(reject_reason, ''), idempotency_key, sequence_number,
		       COALESCE(correlation_id, ''), created_at, updated_at
		FROM mats_orders
	`
}

func scanOrder(row rowScanner) (*domain.Order, error) {
	var order domain.Order
	var price, originalQuantity, remainingQuantity, filledQuantity string
	err := row.Scan(
		&order.ID,
		&order.ClientOrderID,
		&order.BrokerCode,
		&order.AccountID,
		&order.Symbol,
		&order.Side,
		&order.OrderType,
		&price,
		&originalQuantity,
		&remainingQuantity,
		&filledQuantity,
		&order.Status,
		&order.RejectReason,
		&order.IdempotencyKey,
		&order.SequenceNumber,
		&order.CorrelationID,
		&order.CreatedAt,
		&order.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	var parseErr error
	if order.Price, parseErr = parseNumericInt(price); parseErr != nil {
		return nil, fmt.Errorf("parse order price: %w", parseErr)
	}
	if order.OriginalQuantity, parseErr = parseNumericInt(originalQuantity); parseErr != nil {
		return nil, fmt.Errorf("parse original quantity: %w", parseErr)
	}
	if order.RemainingQuantity, parseErr = parseNumericInt(remainingQuantity); parseErr != nil {
		return nil, fmt.Errorf("parse remaining quantity: %w", parseErr)
	}
	if order.FilledQuantity, parseErr = parseNumericInt(filledQuantity); parseErr != nil {
		return nil, fmt.Errorf("parse filled quantity: %w", parseErr)
	}
	return &order, nil
}

func parseNumericInt(value string) (int64, error) {
	parsed, err := strconv.ParseFloat(value, 64)
	if err != nil {
		return 0, err
	}
	return int64(parsed), nil
}
