package events

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"mandala-exchange/mats/internal/bei"
	"mandala-exchange/mats/internal/domain"
	"mandala-exchange/mats/internal/marketdata"
	"mandala-exchange/mats/internal/persistence"
	"mandala-exchange/mats/internal/sequence"
)

const (
	TargetSekuritas = "sekuritas"
	TargetBEI       = "bei"

	TypeOrderStatus           = "order_status"
	TypeTradeFill             = "trade_fill"
	TypeTradeFinal            = "trade_final"
	TypeSessionClosedFinality = "session_closed_finality"
)

type Dispatcher struct {
	store                 persistence.Store
	seq                   sequence.Generator
	beiClient             *bei.Client
	hub                   *marketdata.Hub
	sekuritasEventsURL    string
	sekuritasServiceToken string
	maxAttempts           int
	client                *http.Client
	logger                *slog.Logger
}

type Config struct {
	SekuritasEventsURL    string
	SekuritasServiceToken string
	MaxAttempts           int
}

func NewDispatcher(store persistence.Store, seq sequence.Generator, beiClient *bei.Client, hub *marketdata.Hub, cfg Config, logger *slog.Logger) *Dispatcher {
	if cfg.MaxAttempts <= 0 {
		cfg.MaxAttempts = 5
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &Dispatcher{
		store:                 store,
		seq:                   seq,
		beiClient:             beiClient,
		hub:                   hub,
		sekuritasEventsURL:    cfg.SekuritasEventsURL,
		sekuritasServiceToken: cfg.SekuritasServiceToken,
		maxAttempts:           cfg.MaxAttempts,
		client:                &http.Client{Timeout: 10 * time.Second},
		logger:                logger,
	}
}

func (d *Dispatcher) PublishOrderStatus(ctx context.Context, order *domain.Order) {
	if order == nil {
		return
	}
	payload := OrderStatusPayload{
		ClientOrderID:     order.ClientOrderID,
		MATSOrderID:       order.ID,
		Symbol:            order.Symbol,
		Status:            order.Status,
		Price:             order.Price,
		OriginalQuantity:  order.OriginalQuantity,
		FilledQuantity:    order.FilledQuantity,
		RemainingQuantity: order.RemainingQuantity,
		EventSequence:     order.SequenceNumber,
		RejectReason:      order.RejectReason,
		CorrelationID:     order.CorrelationID,
		OccurredAt:        time.Now().UTC(),
	}
	d.publish(ctx, TargetSekuritas, TypeOrderStatus, order.Symbol, order.CorrelationID, payload)
	d.publishMarketData(order.Symbol, "order_status", payload)
}

func (d *Dispatcher) PublishTrade(ctx context.Context, trade domain.Trade, correlationID string) {
	payload := TradePayload{
		Trade:         trade,
		CorrelationID: correlationID,
	}
	d.publish(ctx, TargetBEI, TypeTradeFinal, trade.Symbol, correlationID, payload)
	d.publishTradeFill(ctx, trade, domain.SideBuy, trade.BuyOrderID, correlationID)
	d.publishTradeFill(ctx, trade, domain.SideSell, trade.SellOrderID, correlationID)
	d.publishMarketData(trade.Symbol, "trade_tape", trade)
	d.publishMarketData(trade.Symbol, "last_price", map[string]any{
		"symbol":      trade.Symbol,
		"last":        trade.Price,
		"occurred_at": trade.OccurredAt,
	})
}

func (d *Dispatcher) publishTradeFill(ctx context.Context, trade domain.Trade, side domain.Side, orderID string, correlationID string) {
	if orderID == "" {
		return
	}
	payload := TradeFillPayload{
		EventType:      TypeTradeFill,
		MATSOrderID:    orderID,
		TradeID:        trade.ID,
		Price:          trade.Price,
		Quantity:       trade.Quantity,
		Side:           side,
		OccurredAt:     trade.OccurredAt,
		IdempotencyKey: fmt.Sprintf("fill:%s:%s", trade.ID, orderID),
		CorrelationID:  correlationID,
	}
	d.publish(ctx, TargetSekuritas, TypeTradeFill, trade.Symbol, correlationID, payload)
}

func (d *Dispatcher) PublishMarketData(symbol string, eventType string, payload any) {
	d.publishMarketData(symbol, eventType, payload)
}

func (d *Dispatcher) Start(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			d.Drain(ctx, 50)
		}
	}
}

func (d *Dispatcher) Drain(ctx context.Context, limit int) {
	events, err := d.store.LoadDueDeliveryEvents(ctx, limit)
	if err != nil {
		d.logger.Warn("load delivery events failed", "error", err)
		return
	}
	for _, event := range events {
		if err := d.deliver(ctx, event); err != nil {
			event.Attempts++
			event.LastError = err.Error()
			if event.EventType == TypeSessionClosedFinality {
				event.Status = "pending"
				event.NextAttemptAt = time.Now().UTC().Add(backoff(event.Attempts))
			} else if event.Attempts >= event.MaxAttempts {
				event.Status = "dead"
			} else {
				event.Status = "pending"
				event.NextAttemptAt = time.Now().UTC().Add(backoff(event.Attempts))
			}
			if updateErr := d.store.UpdateDeliveryEvent(ctx, event); updateErr != nil {
				d.logger.Warn("update failed delivery event failed", "event_id", event.ID, "error", updateErr)
			}
			continue
		}
		event.Status = "delivered"
		event.LastError = ""
		event.NextAttemptAt = time.Now().UTC()
		if err := d.store.UpdateDeliveryEvent(ctx, event); err != nil {
			d.logger.Warn("update delivered event failed", "event_id", event.ID, "error", err)
		}
	}
}

func (d *Dispatcher) publish(ctx context.Context, target, eventType, symbol, correlationID string, payload any) {
	sequenceNumber, err := d.seq.Next(ctx)
	if err != nil {
		d.logger.Warn("generate delivery sequence failed", "error", err)
		return
	}
	now := time.Now().UTC()
	event := persistence.DeliveryEvent{
		ID:             fmt.Sprintf("MATS-D-%d", sequenceNumber),
		SequenceNumber: sequenceNumber,
		Target:         target,
		EventType:      eventType,
		CorrelationID:  correlationID,
		Symbol:         symbol,
		Payload:        payload,
		MaxAttempts:    d.maxAttempts,
		Status:         "pending",
		NextAttemptAt:  now,
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	if err := d.store.SaveDeliveryEvent(ctx, event); err != nil {
		d.logger.Warn("save delivery event failed", "event_id", event.ID, "error", err)
		return
	}
	if err := d.deliver(ctx, event); err != nil {
		event.Attempts = 1
		event.LastError = err.Error()
		if event.EventType == TypeSessionClosedFinality {
			event.Status = "pending"
			event.NextAttemptAt = time.Now().UTC().Add(backoff(event.Attempts))
		} else if event.Attempts >= event.MaxAttempts {
			event.Status = "dead"
		} else {
			event.Status = "pending"
			event.NextAttemptAt = time.Now().UTC().Add(backoff(event.Attempts))
		}
		_ = d.store.UpdateDeliveryEvent(ctx, event)
		return
	}
	event.Status = "delivered"
	event.NextAttemptAt = time.Now().UTC()
	_ = d.store.UpdateDeliveryEvent(ctx, event)
}

func (d *Dispatcher) deliver(ctx context.Context, event persistence.DeliveryEvent) error {
	switch event.Target {
	case TargetBEI:
		if event.EventType == TypeSessionClosedFinality {
			return d.deliverSessionClosedFinalityToBEI(ctx, event)
		}
		return d.deliverTradeToBEI(ctx, event)
	case TargetSekuritas:
		return d.deliverOrderStatusToSekuritas(ctx, event)
	default:
		return fmt.Errorf("unknown_delivery_target_%s", event.Target)
	}
}

func (d *Dispatcher) deliverTradeToBEI(ctx context.Context, event persistence.DeliveryEvent) error {
	payload, err := decodePayload[TradePayload](event.Payload)
	if err != nil {
		return err
	}
	trade := payload.Trade
	err = d.beiClient.CaptureTrade(ctx, bei.TradeCapturePayload{
		MATSTradeID:     trade.ID,
		SequenceNumber:  trade.SequenceNumber,
		SessionID:       trade.SessionID,
		Symbol:          trade.Symbol,
		Price:           trade.Price,
		Quantity:        trade.Quantity,
		BuyBrokerCode:   trade.BuyBrokerCode,
		SellBrokerCode:  trade.SellBrokerCode,
		BuyInvestorID:   trade.BuyAccountID,
		SellInvestorID:  trade.SellAccountID,
		BuyOrderID:      trade.BuyOrderID,
		SellOrderID:     trade.SellOrderID,
		OccurredAt:      trade.OccurredAt,
		IdempotencyKey:  trade.IdempotencyKey,
		SessionState:    "active",
		SecurityStatus:  "listed",
		BuyBrokerState:  "active",
		SellBrokerState: "active",
	})
	if err != nil {
		return err
	}
	// Wake up pending session_closed_finality if any, since we just delivered a trade
	if err := d.store.WakeUpPendingSessionClosedFinality(ctx, trade.SessionID); err != nil {
		d.logger.Warn("failed to wake up pending session_closed_finality", "session_id", trade.SessionID, "error", err)
	}
	return nil
}

func (d *Dispatcher) PublishSessionClosedFinality(ctx context.Context, sessionID string, expectedTradeCount int) {
	payload := SessionClosedFinalityPayload{
		SessionID:          sessionID,
		Status:             domain.SessionClosed,
		ExpectedTradeCount: expectedTradeCount,
	}
	d.publish(ctx, TargetBEI, TypeSessionClosedFinality, "", "", payload)
}

func (d *Dispatcher) deliverSessionClosedFinalityToBEI(ctx context.Context, event persistence.DeliveryEvent) error {
	payload, err := decodePayload[SessionClosedFinalityPayload](event.Payload)
	if err != nil {
		return err
	}
	return d.beiClient.UpdateSessionStatusWithFinality(ctx, payload.SessionID, payload.Status, payload.ExpectedTradeCount, 0)
}

func (d *Dispatcher) deliverOrderStatusToSekuritas(ctx context.Context, event persistence.DeliveryEvent) error {
	if d.sekuritasEventsURL == "" {
		return fmt.Errorf("sekuritas_events_url_not_configured")
	}
	payload, err := json.Marshal(event.Payload)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, d.sekuritasEventsURL, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	request.Header.Set("content-type", "application/json")
	request.Header.Set("x-correlation-id", event.CorrelationID)
	if d.sekuritasServiceToken != "" {
		request.Header.Set("x-service-token", d.sekuritasServiceToken)
	}
	response, err := d.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("sekuritas returned %s", response.Status)
	}
	return nil
}

func (d *Dispatcher) publishMarketData(symbol, eventType string, payload any) {
	if d.hub == nil {
		return
	}
	d.hub.Publish(marketdata.Event{
		Type:       eventType,
		Symbol:     symbol,
		OccurredAt: time.Now().UTC(),
		Payload:    payload,
	})
}

func decodePayload[T any](payload any) (T, error) {
	var target T
	raw, err := json.Marshal(payload)
	if err != nil {
		return target, err
	}
	if err := json.Unmarshal(raw, &target); err != nil {
		return target, err
	}
	return target, nil
}

func backoff(attempt int) time.Duration {
	if attempt <= 0 {
		return time.Second
	}
	if attempt > 5 {
		attempt = 5
	}
	return time.Duration(attempt*attempt) * time.Second
}

type OrderStatusPayload struct {
	ClientOrderID     string             `json:"client_order_id"`
	MATSOrderID       string             `json:"mats_order_id"`
	Symbol            string             `json:"symbol"`
	Status            domain.OrderStatus `json:"status"`
	Price             int64              `json:"price"`
	OriginalQuantity  int64              `json:"original_quantity"`
	FilledQuantity    int64              `json:"filled_quantity"`
	RemainingQuantity int64              `json:"remaining_quantity"`
	EventSequence     int64              `json:"event_sequence"`
	RejectReason      string             `json:"reject_reason,omitempty"`
	CorrelationID     string             `json:"correlation_id,omitempty"`
	OccurredAt        time.Time          `json:"occurred_at"`
}

type TradePayload struct {
	Trade         domain.Trade `json:"trade"`
	CorrelationID string       `json:"correlation_id,omitempty"`
}

type TradeFillPayload struct {
	EventType      string      `json:"event_type"`
	MATSOrderID    string      `json:"mats_order_id"`
	TradeID        string      `json:"trade_id"`
	Price          int64       `json:"price"`
	Quantity       int64       `json:"quantity"`
	Side           domain.Side `json:"side"`
	OccurredAt     time.Time   `json:"occurred_at"`
	IdempotencyKey string      `json:"idempotency_key"`
	CorrelationID  string      `json:"correlation_id,omitempty"`
}

type SessionClosedFinalityPayload struct {
	SessionID          string               `json:"session_id"`
	Status             domain.SessionStatus `json:"status"`
	ExpectedTradeCount int                  `json:"expected_trade_count"`
}
