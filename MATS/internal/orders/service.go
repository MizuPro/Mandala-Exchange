package orders

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"mandala-exchange/mats/internal/bei"
	"mandala-exchange/mats/internal/domain"
	"mandala-exchange/mats/internal/events"
	"mandala-exchange/mats/internal/matching"
	"mandala-exchange/mats/internal/persistence"
	"mandala-exchange/mats/internal/rules"
	"mandala-exchange/mats/internal/sequence"
)

type BrokerValidator interface {
	ValidateBroker(context.Context, string) (bool, string, error)
}

type BEIBrokerValidator struct {
	client *bei.Client
}

func NewBEIBrokerValidator(client *bei.Client) *BEIBrokerValidator {
	return &BEIBrokerValidator{client: client}
}

func (v *BEIBrokerValidator) ValidateBroker(ctx context.Context, code string) (bool, string, error) {
	result, err := v.client.ValidateBroker(ctx, code)
	return result.Valid, result.Reason, err
}

type BrokerValidatorFunc func(context.Context, string) (bool, string, error)

func (f BrokerValidatorFunc) ValidateBroker(ctx context.Context, code string) (bool, string, error) {
	return f(ctx, code)
}

type Service struct {
	engine          *matching.Engine
	store           persistence.Store
	seq             sequence.Generator
	rules           *rules.Cache
	brokerValidator BrokerValidator
	dispatcher      *events.Dispatcher

	mu          sync.Mutex
	idempotency map[string]Response
}

func NewService(engine *matching.Engine, store persistence.Store, seq sequence.Generator, rulesCache *rules.Cache, brokerValidator BrokerValidator) *Service {
	return &Service{
		engine:          engine,
		store:           store,
		seq:             seq,
		rules:           rulesCache,
		brokerValidator: brokerValidator,
		idempotency:     make(map[string]Response),
	}
}

func (s *Service) SetDispatcher(dispatcher *events.Dispatcher) {
	s.dispatcher = dispatcher
}

type PlaceRequest struct {
	ClientOrderID  string           `json:"client_order_id"`
	BrokerCode     string           `json:"broker_code"`
	AccountID      string           `json:"account_id"`
	Symbol         string           `json:"symbol"`
	Side           domain.Side      `json:"side"`
	OrderType      domain.OrderType `json:"order_type"`
	Price          int64            `json:"price"`
	Quantity       int64            `json:"quantity"`
	IdempotencyKey string           `json:"idempotency_key"`
	IsShortSell    bool             `json:"is_short_sell"`
	IsMargin       bool             `json:"is_margin"`
	CorrelationID  string           `json:"correlation_id"`
}

type AmendRequest struct {
	OrderID        string `json:"-"`
	Price          *int64 `json:"price"`
	Quantity       *int64 `json:"quantity"`
	IdempotencyKey string `json:"idempotency_key"`
	CorrelationID  string `json:"correlation_id"`
}

type CancelRequest struct {
	OrderID        string `json:"-"`
	IdempotencyKey string `json:"idempotency_key"`
	CorrelationID  string `json:"correlation_id"`
}

type Response struct {
	Order  *domain.Order  `json:"order"`
	Trades []domain.Trade `json:"trades"`
}

func (s *Service) Place(ctx context.Context, req PlaceRequest) (Response, error) {
	req.normalize()
	if err := req.validateShape(); err != nil {
		return Response{}, err
	}
	if response, ok := s.idempotentResponse(req.IdempotencyKey); ok {
		return response, nil
	}
	// Fallback ke persistent store untuk ketahanan setelah restart
	if req.IdempotencyKey != "" {
		if existing, err := s.store.FindOrderByIdempotency(ctx, req.IdempotencyKey); err == nil && existing != nil {
			trades, _ := s.store.FindTradesByOrderID(ctx, existing.ID)
			response := Response{Order: existing.Clone(), Trades: trades}
			s.remember(req.IdempotencyKey, response)
			return response, nil
		}
	}

	sequenceNumber, err := s.seq.Next(ctx)
	if err != nil {
		return Response{}, err
	}
	order := newOrder(sequenceNumber, req)

	if s.brokerValidator != nil {
		valid, reason, err := s.brokerValidator.ValidateBroker(ctx, order.BrokerCode)
		if err != nil {
			return Response{}, fmt.Errorf("broker validation unavailable: %w", err)
		}
		if !valid {
			return s.reject(ctx, order, normalizeRejectReason(reason, "broker_invalid"))
		}
	}

	rejectReason := s.rules.ValidatePlace(rules.PlaceValidationRequest{
		Symbol:      order.Symbol,
		Side:        order.Side,
		OrderType:   order.OrderType,
		Price:       order.Price,
		Quantity:    order.OriginalQuantity,
		IsShortSell: req.IsShortSell,
		IsMargin:    req.IsMargin,
	})
	if rejectReason != "" {
		return s.reject(ctx, order, rejectReason)
	}
	if rejectReason := s.validatePostClosingPrice(order.Symbol, order.Price); rejectReason != "" {
		return s.reject(ctx, order, rejectReason)
	}

	order.Status = domain.OrderStatusAccepted
	if err := s.store.SaveOrder(ctx, order); err != nil {
		return Response{}, err
	}
	_ = s.appendEvent(ctx, "order_accepted", order, "", order)

	if s.rules.IsAuctionCollection() {
		s.engine.PlaceAuction(order)
		if err := s.store.UpdateOrder(ctx, order); err != nil {
			return Response{}, err
		}
		_ = s.appendEvent(ctx, "auction_order_collected", order, "", order)
		s.publishOrderStatus(ctx, order)
		s.publishBookAndSummary(order.Symbol)
		s.publishIndicative(order.Symbol)
		response := Response{Order: order.Clone(), Trades: nil}
		s.remember(req.IdempotencyKey, response)
		return response, nil
	}

	trades, updatedResting, err := s.engine.Place(ctx, order)
	if err != nil {
		return Response{}, err
	}
	now := time.Now().UTC()
	order.UpdatedAt = now
	for _, resting := range updatedResting {
		if err := s.store.UpdateOrder(ctx, resting); err != nil {
			return Response{}, err
		}
		_ = s.appendEvent(ctx, "order_status", resting, "", resting)
		s.publishOrderStatus(ctx, resting)
	}
	for _, trade := range trades {
		if err := s.store.SaveTrade(ctx, &trade); err != nil {
			return Response{}, err
		}
		_ = s.appendEvent(ctx, "trade_generated", nil, trade.ID, trade)
		s.publishTrade(ctx, trade, order.CorrelationID)
	}
	if err := s.store.UpdateOrder(ctx, order); err != nil {
		return Response{}, err
	}
	_ = s.appendEvent(ctx, "order_status", order, "", order)
	s.publishOrderStatus(ctx, order)
	s.publishBookAndSummary(order.Symbol)

	response := Response{Order: order.Clone(), Trades: trades}
	s.remember(req.IdempotencyKey, response)
	return response, nil
}

func (s *Service) Amend(ctx context.Context, req AmendRequest) (Response, error) {
	if req.IdempotencyKey == "" {
		return Response{}, fmt.Errorf("idempotency_key_required")
	}
	requestHash := hashIdempotencyRequest("amend", map[string]any{
		"order_id": req.OrderID,
		"price":    req.Price,
		"quantity": req.Quantity,
	})
	if response, found, err := s.persistedIdempotentResponse(ctx, req.IdempotencyKey, "amend", requestHash); err != nil {
		return Response{}, err
	} else if found {
		return response, nil
	}
	if response, ok := s.idempotentResponse(req.IdempotencyKey); ok {
		return response, nil
	}
	existing, ok := s.engine.Get(req.OrderID)
	if !ok {
		return Response{}, matching.ErrOrderNotFound
	}
	if existing.OrderType == domain.OrderTypeMarket {
		return Response{}, fmt.Errorf("market_order_cannot_be_amended")
	}
	if rejectReason := s.rules.ValidateAmend(rules.AmendValidationRequest{OrderID: req.OrderID}); rejectReason != "" {
		if rejectReason == string(domain.OrderStatusLockedNonCancellable) {
			existing.Status = domain.OrderStatusLockedNonCancellable
			existing.RejectReason = "non_cancellation_period"
			_ = s.store.UpdateOrder(ctx, existing)
			response := Response{Order: existing, Trades: nil}
			if err := s.rememberPersistent(ctx, req.IdempotencyKey, "amend", existing.ID, requestHash, response); err != nil {
				return Response{}, err
			}
			return response, nil
		}
		return Response{}, errors.New(rejectReason)
	}

	price := existing.Price
	if req.Price != nil {
		price = *req.Price
	}
	quantity := existing.OriginalQuantity
	if req.Quantity != nil {
		quantity = *req.Quantity
	}
	if rejectReason := s.rules.ValidatePlace(rules.PlaceValidationRequest{
		Symbol:    existing.Symbol,
		Side:      existing.Side,
		OrderType: existing.OrderType,
		Price:     price,
		Quantity:  quantity,
	}); rejectReason != "" {
		return Response{}, errors.New(rejectReason)
	}
	if rejectReason := s.validatePostClosingPrice(existing.Symbol, price); rejectReason != "" {
		return Response{}, errors.New(rejectReason)
	}

	sequenceNumber, err := s.seq.Next(ctx)
	if err != nil {
		return Response{}, err
	}
	order, trades, updatedResting, err := s.engine.Amend(ctx, req.OrderID, req.Price, req.Quantity, sequenceNumber)
	if err != nil {
		return Response{}, err
	}
	for _, resting := range updatedResting {
		if err := s.store.UpdateOrder(ctx, resting); err != nil {
			return Response{}, err
		}
		_ = s.appendEvent(ctx, "order_status", resting, "", resting)
		s.publishOrderStatus(ctx, resting)
	}
	for _, trade := range trades {
		if err := s.store.SaveTrade(ctx, &trade); err != nil {
			return Response{}, err
		}
		_ = s.appendEvent(ctx, "trade_generated", nil, trade.ID, trade)
		s.publishTrade(ctx, trade, order.CorrelationID)
	}
	if err := s.store.UpdateOrder(ctx, order); err != nil {
		return Response{}, err
	}
	_ = s.appendEvent(ctx, "order_amended", order, "", order)
	s.publishOrderStatus(ctx, order)
	s.publishBookAndSummary(order.Symbol)

	response := Response{Order: order, Trades: trades}
	if err := s.rememberPersistent(ctx, req.IdempotencyKey, "amend", order.ID, requestHash, response); err != nil {
		return Response{}, err
	}
	return response, nil
}

func (s *Service) Cancel(ctx context.Context, req CancelRequest) (Response, error) {
	if req.IdempotencyKey == "" {
		return Response{}, fmt.Errorf("idempotency_key_required")
	}
	requestHash := hashIdempotencyRequest("cancel", map[string]any{
		"order_id": req.OrderID,
	})
	if response, found, err := s.persistedIdempotentResponse(ctx, req.IdempotencyKey, "cancel", requestHash); err != nil {
		return Response{}, err
	} else if found {
		return response, nil
	}
	if response, ok := s.idempotentResponse(req.IdempotencyKey); ok {
		return response, nil
	}
	if rejectReason := s.rules.ValidateAmend(rules.AmendValidationRequest{OrderID: req.OrderID}); rejectReason != "" {
		if rejectReason == string(domain.OrderStatusLockedNonCancellable) {
			order, _ := s.engine.Get(req.OrderID)
			if order != nil {
				order.Status = domain.OrderStatusLockedNonCancellable
				order.RejectReason = "non_cancellation_period"
				_ = s.store.UpdateOrder(ctx, order)
			}
			response := Response{Order: order, Trades: nil}
			if err := s.rememberPersistent(ctx, req.IdempotencyKey, "cancel", req.OrderID, requestHash, response); err != nil {
				return Response{}, err
			}
			return response, nil
		}
		return Response{}, errors.New(rejectReason)
	}
	order, err := s.engine.Cancel(req.OrderID)
	if err != nil {
		return Response{}, err
	}
	if err := s.store.UpdateOrder(ctx, order); err != nil {
		return Response{}, err
	}
	_ = s.appendEvent(ctx, "order_cancelled", order, "", order)
	s.publishOrderStatus(ctx, order)
	s.publishBookAndSummary(order.Symbol)

	response := Response{Order: order, Trades: nil}
	if err := s.rememberPersistent(ctx, req.IdempotencyKey, "cancel", order.ID, requestHash, response); err != nil {
		return Response{}, err
	}
	return response, nil
}

func (s *Service) Get(ctx context.Context, orderID string) (*domain.Order, error) {
	if order, ok := s.engine.Get(orderID); ok {
		return order, nil
	}
	order, err := s.store.FindOrderByID(ctx, orderID)
	if errors.Is(err, persistence.ErrNotFound) {
		return nil, matching.ErrOrderNotFound
	}
	return order, err
}

func (s *Service) Recover(ctx context.Context) error {
	orders, err := s.store.LoadOpenOrders(ctx)
	if err != nil {
		return err
	}
	s.engine.Recover(orders)
	return nil
}

func (s *Service) CountSessionTrades(ctx context.Context, sessionID string) (int, error) {
	return s.store.CountSessionTrades(ctx, sessionID)
}

func (s *Service) ExpireOpenOrders(ctx context.Context) ([]*domain.Order, error) {
	expired := s.engine.ExpireOpenOrders()
	for _, order := range expired {
		if err := s.store.UpdateOrder(ctx, order); err != nil {
			return nil, err
		}
		_ = s.appendEvent(ctx, "order_expired", order, "", order)
		s.publishOrderStatus(ctx, order)
		s.publishBookAndSummary(order.Symbol)
	}
	return expired, nil
}

func (s *Service) Indicative(symbol string) domain.IndicativePriceVolume {
	symbol = strings.ToUpper(strings.TrimSpace(symbol))
	return s.engine.Indicative(symbol, s.rules.ReferencePrice(symbol))
}

func (s *Service) UncrossAuction(ctx context.Context, symbol string) (domain.IndicativePriceVolume, []domain.Trade, []*domain.Order, error) {
	symbol = strings.ToUpper(strings.TrimSpace(symbol))
	indicative, trades, updatedOrders, err := s.engine.UncrossAuction(ctx, symbol, s.rules.ReferencePrice(symbol))
	if err != nil {
		return indicative, nil, nil, err
	}
	for _, order := range updatedOrders {
		if err := s.store.UpdateOrder(ctx, order); err != nil {
			return indicative, nil, nil, err
		}
		_ = s.appendEvent(ctx, "auction_order_status", order, "", order)
		s.publishOrderStatus(ctx, order)
	}
	for _, trade := range trades {
		if err := s.store.SaveTrade(ctx, &trade); err != nil {
			return indicative, nil, nil, err
		}
		_ = s.appendEvent(ctx, "auction_trade_generated", nil, trade.ID, trade)
		s.publishTrade(ctx, trade, "")
	}
	s.publishIndicative(symbol)
	s.publishBookAndSummary(symbol)
	return indicative, trades, updatedOrders, nil
}

func (s *Service) reject(ctx context.Context, order *domain.Order, reason string) (Response, error) {
	now := time.Now().UTC()
	order.Status = domain.OrderStatusRejected
	order.RejectReason = reason
	order.RemainingQuantity = 0
	order.UpdatedAt = now
	if err := s.store.SaveOrder(ctx, order); err != nil {
		return Response{}, err
	}
	_ = s.appendEvent(ctx, "order_rejected", order, "", order)
	s.publishOrderStatus(ctx, order)
	response := Response{Order: order.Clone(), Trades: nil}
	s.remember(order.IdempotencyKey, response)
	return response, nil
}

func (s *Service) publishOrderStatus(ctx context.Context, order *domain.Order) {
	if s.dispatcher != nil {
		s.dispatcher.PublishOrderStatus(ctx, order)
	}
}

func (s *Service) publishTrade(ctx context.Context, trade domain.Trade, correlationID string) {
	if s.dispatcher != nil {
		s.dispatcher.PublishTrade(ctx, trade, correlationID)
	}
}

func (s *Service) publishBookAndSummary(symbol string) {
	if s.dispatcher == nil {
		return
	}
	snapshot := s.engine.Snapshot(symbol)
	s.dispatcher.PublishMarketData(symbol, "depth_snapshot", snapshot)
	s.dispatcher.PublishMarketData(symbol, "best_bid_ask", bestBidAsk(snapshot))
	if summary, ok := s.engine.Summary(symbol); ok {
		s.dispatcher.PublishMarketData(symbol, "market_summary", summary)
	}
}

func (s *Service) publishIndicative(symbol string) {
	if s.dispatcher == nil {
		return
	}
	indicative := s.Indicative(symbol)
	s.dispatcher.PublishMarketData(symbol, "iep_iev", indicative)
}

func bestBidAsk(snapshot domain.BookSnapshot) map[string]any {
	var bestBid any
	var bestAsk any
	if len(snapshot.Bids) > 0 {
		bestBid = snapshot.Bids[0]
	}
	if len(snapshot.Asks) > 0 {
		bestAsk = snapshot.Asks[0]
	}
	return map[string]any{
		"symbol":   snapshot.Symbol,
		"best_bid": bestBid,
		"best_ask": bestAsk,
	}
}

func (s *Service) validatePostClosingPrice(symbol string, price int64) string {
	if s.rules.ActiveSessionStatus() != domain.SessionPostClosing {
		return ""
	}
	summary, ok := s.engine.Summary(symbol)
	if !ok || summary.Close <= 0 {
		return "closing_price_unavailable"
	}
	if price != summary.Close {
		return "post_closing_requires_closing_price"
	}
	return ""
}

func (s *Service) appendEvent(ctx context.Context, eventType string, order *domain.Order, tradeID string, payload any) error {
	sequenceNumber, err := s.seq.Next(ctx)
	if err != nil {
		return err
	}
	event := persistence.Event{
		ID:             fmt.Sprintf("MATS-E-%d", sequenceNumber),
		SequenceNumber: sequenceNumber,
		EventType:      eventType,
		TradeID:        tradeID,
		Payload:        payload,
		CreatedAt:      time.Now().UTC(),
	}
	if order != nil {
		event.OrderID = order.ID
		event.Symbol = order.Symbol
	}
	return s.store.AppendEvent(ctx, event)
}

func (s *Service) idempotentResponse(key string) (Response, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	response, ok := s.idempotency[key]
	return response, ok
}

func (s *Service) remember(key string, response Response) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.idempotency[key] = response
}

func (s *Service) persistedIdempotentResponse(ctx context.Context, key, operation, requestHash string) (Response, bool, error) {
	record, err := s.store.FindIdempotencyRecord(ctx, key)
	if errors.Is(err, persistence.ErrNotFound) {
		return Response{}, false, nil
	}
	if err != nil {
		return Response{}, false, err
	}
	if record.Operation != operation || record.RequestHash != requestHash {
		return Response{}, false, fmt.Errorf("idempotency_key_payload_conflict")
	}
	var response Response
	if err := json.Unmarshal(record.Response, &response); err != nil {
		return Response{}, false, err
	}
	s.remember(key, response)
	return response, true, nil
}

func (s *Service) rememberPersistent(ctx context.Context, key, operation, resourceID, requestHash string, response Response) error {
	payload, err := json.Marshal(response)
	if err != nil {
		return err
	}
	if err := s.store.SaveIdempotencyRecord(ctx, persistence.IdempotencyRecord{
		Key:         key,
		Operation:   operation,
		ResourceID:  resourceID,
		RequestHash: requestHash,
		Response:    payload,
		CreatedAt:   time.Now().UTC(),
	}); err != nil {
		return err
	}
	s.remember(key, response)
	return nil
}

func hashIdempotencyRequest(operation string, value any) string {
	payload, _ := json.Marshal(struct {
		Operation string `json:"operation"`
		Request   any    `json:"request"`
	}{Operation: operation, Request: value})
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}

func newOrder(sequenceNumber int64, req PlaceRequest) *domain.Order {
	now := time.Now().UTC()
	return &domain.Order{
		ID:                fmt.Sprintf("MATS-O-%d", sequenceNumber),
		ClientOrderID:     req.ClientOrderID,
		BrokerCode:        req.BrokerCode,
		AccountID:         req.AccountID,
		Symbol:            req.Symbol,
		Side:              req.Side,
		OrderType:         req.OrderType,
		Price:             req.Price,
		OriginalQuantity:  req.Quantity,
		RemainingQuantity: req.Quantity,
		IdempotencyKey:    req.IdempotencyKey,
		SequenceNumber:    sequenceNumber,
		CorrelationID:     req.CorrelationID,
		CreatedAt:         now,
		UpdatedAt:         now,
	}
}

func (r *PlaceRequest) normalize() {
	r.ClientOrderID = strings.TrimSpace(r.ClientOrderID)
	r.BrokerCode = strings.ToUpper(strings.TrimSpace(r.BrokerCode))
	r.AccountID = strings.TrimSpace(r.AccountID)
	r.Symbol = strings.ToUpper(strings.TrimSpace(r.Symbol))
	r.Side = domain.Side(strings.ToLower(strings.TrimSpace(string(r.Side))))
	r.OrderType = domain.OrderType(strings.ToLower(strings.TrimSpace(string(r.OrderType))))
	if r.OrderType == "" {
		r.OrderType = domain.OrderTypeLimit
	}
	r.IdempotencyKey = strings.TrimSpace(r.IdempotencyKey)
}

func (r PlaceRequest) validateShape() error {
	switch {
	case r.ClientOrderID == "":
		return fmt.Errorf("client_order_id_required")
	case r.BrokerCode == "":
		return fmt.Errorf("broker_code_required")
	case r.AccountID == "":
		return fmt.Errorf("account_id_required")
	case r.Symbol == "":
		return fmt.Errorf("symbol_required")
	case r.Side != domain.SideBuy && r.Side != domain.SideSell:
		return fmt.Errorf("invalid_side")
	case r.OrderType != domain.OrderTypeLimit && r.OrderType != domain.OrderTypeMarket:
		return fmt.Errorf("unsupported_order_type")
	case r.OrderType == domain.OrderTypeLimit && r.Price <= 0:
		return fmt.Errorf("price_must_be_positive")
	case r.Quantity <= 0:
		return fmt.Errorf("quantity_must_be_positive")
	case r.IdempotencyKey == "":
		return fmt.Errorf("idempotency_key_required")
	}
	return nil
}

func normalizeRejectReason(reason, fallback string) string {
	reason = strings.TrimSpace(reason)
	if reason == "" {
		return fallback
	}
	return reason
}
