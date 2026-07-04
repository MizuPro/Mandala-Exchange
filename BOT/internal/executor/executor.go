package executor

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/Mandala-Exchange/bot-v2/internal/client"
	"github.com/Mandala-Exchange/bot-v2/internal/client/bei"
	"github.com/Mandala-Exchange/bot-v2/internal/client/sekuritas"
	"github.com/Mandala-Exchange/bot-v2/internal/config"
	"github.com/Mandala-Exchange/bot-v2/internal/logger"
	"github.com/Mandala-Exchange/bot-v2/internal/metrics"
	"github.com/Mandala-Exchange/bot-v2/internal/queue"
	"github.com/Mandala-Exchange/bot-v2/internal/registry"
	"golang.org/x/time/rate"
)

type Executor struct {
	beiClient       *bei.Client
	sekuritasClient *sekuritas.Client
	reg             *registry.Registry
	ordQueue        *queue.OrderQueue
	rateLimiter     *rate.Limiter
	metricsManager  *metrics.Manager
	stratCfg        config.StrategyConfig

	paused   bool
	pausedMu sync.RWMutex
}

func NewExecutor(
	beiClient *bei.Client,
	sekuritasClient *sekuritas.Client,
	reg *registry.Registry,
	ordQueue *queue.OrderQueue,
	ordersPerMin int,
	metricsManager *metrics.Manager,
	stratCfg config.StrategyConfig,
) *Executor {
	if ordersPerMin <= 0 {
		ordersPerMin = 60 // Default 60 orders/minute
	}
	limiter := rate.NewLimiter(rate.Limit(float64(ordersPerMin)/60.0), 5) // Burst size 5

	return &Executor{
		beiClient:       beiClient,
		sekuritasClient: sekuritasClient,
		reg:             reg,
		ordQueue:        ordQueue,
		rateLimiter:     limiter,
		metricsManager:  metricsManager,
		stratCfg:        stratCfg,
	}
}

func (e *Executor) getMaxOrdersForBot(strategy string) int {
	// Fallback default ke 3 jika limit dari config belum diinisialisasi (misal di mock unit test)
	limit := 3
	switch strategy {
	case "noise_trader":
		if e.stratCfg.NoiseTrader.MaxOrdersPerSession > 0 {
			limit = e.stratCfg.NoiseTrader.MaxOrdersPerSession
		}
	case "momentum_trader":
		if e.stratCfg.MomentumTrader.MaxOrdersPerSession > 0 {
			limit = e.stratCfg.MomentumTrader.MaxOrdersPerSession
		}
	case "contrarian":
		if e.stratCfg.Contrarian.MaxOrdersPerSession > 0 {
			limit = e.stratCfg.Contrarian.MaxOrdersPerSession
		}
	case "event_driven":
		if e.stratCfg.EventDriven.MaxOrdersPerSession > 0 {
			limit = e.stratCfg.EventDriven.MaxOrdersPerSession
		}
	case "market_maker":
		if e.stratCfg.MarketMaker.MaxOrdersPerSession > 0 {
			limit = e.stratCfg.MarketMaker.MaxOrdersPerSession
		}
	case "value_investor":
		if e.stratCfg.ValueInvestor.MaxOrdersPerSession > 0 {
			limit = e.stratCfg.ValueInvestor.MaxOrdersPerSession
		}
	case "index_tracker":
		if e.stratCfg.IndexTracker.MaxOrdersPerSession > 0 {
			limit = e.stratCfg.IndexTracker.MaxOrdersPerSession
		}
	case "bandar":
		if e.stratCfg.Bandar.MaxOrdersPerSession > 0 {
			limit = e.stratCfg.Bandar.MaxOrdersPerSession
		}
	}
	return limit
}

func (e *Executor) SetPaused(p bool) {
	e.pausedMu.Lock()
	defer e.pausedMu.Unlock()
	e.paused = p
	logger.Info("Executor pause state changed", "paused", p)
}

func (e *Executor) IsPaused() bool {
	e.pausedMu.RLock()
	defer e.pausedMu.RUnlock()
	return e.paused
}

func (e *Executor) Start(ctx context.Context) {
	go e.workerLoop(ctx)
}

func (e *Executor) workerLoop(ctx context.Context) {
	logger.Info("Order executor worker loop started")
	for {
		select {
		case <-ctx.Done():
			logger.Info("Order executor worker loop exiting due to context cancel")
			return
		default:
		}

		// Block dequeue
		dec, err := e.ordQueue.Dequeue(ctx)
		if err != nil {
			if errors.Is(err, context.Canceled) {
				return
			}
			logger.Error("Error dequeuing order decision", "error", err.Error())
			continue
		}

		// Record Queue Depth
		beiSnap := e.beiClient.GetSnapshot()
		sessID := ""
		if beiSnap.Session != nil && beiSnap.Session.ID != "" {
			sessID = beiSnap.Session.ID
		} else {
			sessID = time.Now().Format("2006-01-02")
		}
		e.metricsManager.RecordQueueDepth(sessID, int64(e.ordQueue.Size()))

		// Wait on rate limiter
		if err := e.rateLimiter.Wait(ctx); err != nil {
			if errors.Is(err, context.Canceled) {
				return
			}
			logger.Error("Rate limiter Wait error", "error", err.Error())
			continue
		}

		// Perform pre-execution checks
		if e.IsPaused() {
			logger.Warn("Executor is PAUSED. Dropping order decision.", "client_order_id", dec.ClientOrderID)
			continue
		}

		// Get Bot Instance
		bot, ok := e.reg.GetBot(dec.AccountID)
		if !ok {
			logger.Error("Executor: Bot instance not found in registry", "account_id", dec.AccountID)
			continue
		}

		// Bankrupt check
		if bot.GetStatus() == "bankrupt" {
			logger.Warn("Bot is bankrupt. Dropping order decision.", "account_id", dec.AccountID)
			continue
		}

		// BEI Staleness checks
		if e.beiClient.IsSessionStale() {
			logger.Warn("BEI session data is STALE. Pausing order submission.", "client_order_id", dec.ClientOrderID)
			continue
		}

		if e.beiClient.IsRulesStale() || e.beiClient.IsFeesStale() {
			logger.Warn("BEI rules or fees are STALE. Fail-closed: Dropping order decision.", "client_order_id", dec.ClientOrderID)
			continue
		}

		// Session Segment checks
		snapshot := e.beiClient.GetSnapshot()
		sessionSegment := ""
		if snapshot.Session != nil {
			sessionSegment = snapshot.Session.Status
		}

		allowedSegments := map[string]bool{
			"opening_auction": true,
			"continuous":      true,
			"closing_auction": true,
		}

		if !allowedSegments[sessionSegment] {
			logger.Warn("Order submission blocked: Session segment not allowed", "segment", sessionSegment, "client_order_id", dec.ClientOrderID)
			continue
		}

		// Bot session-level guardrail menggunakan instance ID yang sama dengan strategy/runner.
		sessionID := sessionSegment
		if snapshot.Session != nil && snapshot.Session.ID != "" {
			sessionID = snapshot.Session.ID
		}
		ordersCount := bot.GetOrdersThisSession(sessionID)
		limit := e.getMaxOrdersForBot(bot.Strategy)
		if ordersCount >= limit {
			logger.Warn("Bot session order limit reached. Dropping order decision.",
				"account_id", dec.AccountID, "limit", limit, "segment", sessionSegment)
			continue
		}

		// Guardrail: tidak cancel/amend pada non_cancellation segment
		if dec.Action == "cancel" || dec.Action == "amend" {
			if sessionSegment == "non_cancellation" {
				logger.Warn("Cancel/Amend blocked: Session segment is non_cancellation",
					"action", dec.Action, "target_order_id", dec.TargetOrderID)
				continue
			}
		}

		// Execute based on Action
		switch dec.Action {
		case "cancel":
			e.executeCancel(ctx, bot, dec)
		case "amend":
			e.executeAmend(ctx, bot, dec)
		default:
			e.executeOrder(ctx, bot, dec)
		}
	}
}

func (e *Executor) executeOrder(ctx context.Context, bot *registry.BotInstance, dec queue.OrderDecision) {
	req := sekuritas.PlaceOrderRequest{
		ClientOrderID: dec.ClientOrderID,
		Symbol:        dec.Symbol,
		Side:          dec.Side,
		OrderType:     dec.OrderType,
		PriceIDR:      dec.Price,
		Quantity:      dec.Quantity,
	}

	logger.Info("Submitting order to Sekuritas",
		"account_id", dec.AccountID,
		"client_order_id", dec.ClientOrderID,
		"symbol", dec.Symbol,
		"side", dec.Side,
		"price", dec.Price,
		"qty", dec.Quantity,
	)

	beiSnap := e.beiClient.GetSnapshot()
	sessID := ""
	if beiSnap.Session != nil && beiSnap.Session.ID != "" {
		sessID = beiSnap.Session.ID
	} else {
		sessID = time.Now().Format("2006-01-02")
	}

	start := time.Now()
	resp, err := e.sekuritasClient.PlaceOrder(ctx, dec.AccountID, req)
	latencyMs := time.Since(start).Milliseconds()
	e.metricsManager.RecordLatency(sessID, bot.Strategy, latencyMs)

	if err != nil {
		if errors.Is(err, sekuritas.ErrTokenExpired) || errors.Is(err, sekuritas.ErrTokenNotFound) {
			logger.Error("Order submit blocked: Invalid token", "account_id", dec.AccountID, "error", err.Error())
			return
		}

		if errors.Is(err, sekuritas.ErrOrderSubmitUnknown) {
			logger.Warn("Order status unknown (timeout/5xx). Triggering immediate reconcile...", "client_order_id", dec.ClientOrderID)
			e.reconcileOrderOutcome(ctx, bot, dec)
			return
		}

		logger.Error("Order submission rejected by Sekuritas", "client_order_id", dec.ClientOrderID, "error", err.Error())
		e.metricsManager.RecordRejectReason(sessID, bot.Strategy, err.Error())
		return
	}

	if resp.Status == "rejected" {
		logger.Warn("Order rejected by Sekuritas",
			"client_order_id", dec.ClientOrderID,
			"sekuritas_order_id", resp.ID,
			"reject_reason", resp.RejectReason,
		)
		e.metricsManager.RecordRejectReason(sessID, bot.Strategy, resp.RejectReason)
		return
	}

	// Success
	bot.SetOpenOrderID(dec.ClientOrderID, resp.ID)
	e.metricsManager.RecordAction(sessID, bot.Strategy, "place")

	logger.Info("Order placed successfully",
		"client_order_id", dec.ClientOrderID,
		"sekuritas_order_id", resp.ID,
		"status", resp.Status,
	)
}

func (e *Executor) reconcileOrderOutcome(ctx context.Context, bot *registry.BotInstance, dec queue.OrderDecision) {
	// Reconcile lookup retries 3x with backoff
	backoff := 500 * time.Millisecond
	for attempt := 1; attempt <= 3; attempt++ {
		logger.Info("Reconciling order", "client_order_id", dec.ClientOrderID, "attempt", attempt)
		resp, err := e.sekuritasClient.GetOrderByClientID(ctx, dec.AccountID, dec.ClientOrderID)
		if err == nil {
			// Found! Order was created in Sekuritas
			bot.OpenOrderIDs[dec.ClientOrderID] = resp.ID
			logger.Info("Reconcile SUCCESS: Order found in Sekuritas",
				"client_order_id", dec.ClientOrderID,
				"sekuritas_order_id", resp.ID,
				"status", resp.Status,
			)
			return
		}

		// Check if error is 404 (Not Found)
		var apiErr *client.APIError
		if errors.As(err, &apiErr) && apiErr.Status == 404 {
			// Order definitely did not reach Sekuritas or was rejected before DB insert.
			logger.Warn("Reconcile COMPLETE: Order was NOT created in Sekuritas (404)", "client_order_id", dec.ClientOrderID)
			return
		}

		// Network/5xx error during reconcile lookup, retry with backoff
		logger.Warn("Reconcile request failed, retrying...", "client_order_id", dec.ClientOrderID, "error", err.Error())

		if attempt < 3 {
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
				backoff *= 2
			}
		}
	}

	logger.Error("Reconcile FAILED after max attempts. Order state remains unknown.", "client_order_id", dec.ClientOrderID)
}

func (e *Executor) executeCancel(ctx context.Context, bot *registry.BotInstance, dec queue.OrderDecision) {
	if dec.TargetOrderID == "" {
		logger.Error("Cancel blocked: TargetOrderID is empty", "account_id", dec.AccountID)
		return
	}

	beiSnap := e.beiClient.GetSnapshot()
	sessID := ""
	if beiSnap.Session != nil && beiSnap.Session.ID != "" {
		sessID = beiSnap.Session.ID
	} else {
		sessID = time.Now().Format("2006-01-02")
	}

	logger.Info("Submitting cancel order request to Sekuritas",
		"account_id", dec.AccountID,
		"target_order_id", dec.TargetOrderID,
	)

	start := time.Now()
	err := e.sekuritasClient.CancelOrder(ctx, dec.AccountID, dec.TargetOrderID)
	latencyMs := time.Since(start).Milliseconds()
	e.metricsManager.RecordLatency(sessID, bot.Strategy, latencyMs)

	if err != nil {
		logger.Error("Cancel order failed in Sekuritas",
			"account_id", dec.AccountID,
			"target_order_id", dec.TargetOrderID,
			"error", err.Error(),
		)
		e.metricsManager.RecordRejectReason(sessID, bot.Strategy, err.Error())
		return
	}

	bot.DeleteOpenOrderBySekuritasID(dec.TargetOrderID)
	e.metricsManager.RecordAction(sessID, bot.Strategy, "cancel")

	logger.Info("Order cancelled successfully",
		"account_id", dec.AccountID,
		"target_order_id", dec.TargetOrderID,
	)
}

func (e *Executor) executeAmend(ctx context.Context, bot *registry.BotInstance, dec queue.OrderDecision) {
	if dec.TargetOrderID == "" {
		logger.Error("Amend blocked: TargetOrderID is empty", "account_id", dec.AccountID)
		return
	}

	beiSnap := e.beiClient.GetSnapshot()
	sessID := ""
	if beiSnap.Session != nil && beiSnap.Session.ID != "" {
		sessID = beiSnap.Session.ID
	} else {
		sessID = time.Now().Format("2006-01-02")
	}

	logger.Info("Submitting amend order request to Sekuritas",
		"account_id", dec.AccountID,
		"target_order_id", dec.TargetOrderID,
		"price", dec.Price,
		"qty", dec.Quantity,
	)

	req := sekuritas.AmendOrderRequest{
		PriceIDR: dec.Price,
		Quantity: dec.Quantity,
	}

	start := time.Now()
	err := e.sekuritasClient.AmendOrder(ctx, dec.AccountID, dec.TargetOrderID, req)
	latencyMs := time.Since(start).Milliseconds()
	e.metricsManager.RecordLatency(sessID, bot.Strategy, latencyMs)

	if err != nil {
		logger.Error("Amend order failed in Sekuritas",
			"account_id", dec.AccountID,
			"target_order_id", dec.TargetOrderID,
			"error", err.Error(),
		)
		e.metricsManager.RecordRejectReason(sessID, bot.Strategy, err.Error())
		return
	}

	e.metricsManager.RecordAction(sessID, bot.Strategy, "amend")

	logger.Info("Order amended successfully",
		"account_id", dec.AccountID,
		"target_order_id", dec.TargetOrderID,
		"new_price", dec.Price,
		"new_qty", dec.Quantity,
	)
}

