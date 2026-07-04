package executor

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/Mandala-Exchange/bot-v2/internal/client"
	"github.com/Mandala-Exchange/bot-v2/internal/client/bei"
	"github.com/Mandala-Exchange/bot-v2/internal/client/sekuritas"
	"github.com/Mandala-Exchange/bot-v2/internal/logger"
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

	paused    bool
	pausedMu  sync.RWMutex
	maxOrders int // max orders per session per bot (e.g., 3)
}

func NewExecutor(beiClient *bei.Client, sekuritasClient *sekuritas.Client, reg *registry.Registry, ordQueue *queue.OrderQueue, ordersPerMin int) *Executor {
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
		maxOrders:       3, // Default MVP max orders per bot per session
	}
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
		if ordersCount >= e.maxOrders {
			logger.Warn("Bot session order limit reached. Dropping order decision.",
				"account_id", dec.AccountID, "limit", e.maxOrders, "segment", sessionSegment)
			continue
		}

		// Execute place order
		e.executeOrder(ctx, bot, dec)
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

	resp, err := e.sekuritasClient.PlaceOrder(ctx, dec.AccountID, req)
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
		return
	}

	if resp.Status == "rejected" {
		logger.Warn("Order rejected by Sekuritas",
			"client_order_id", dec.ClientOrderID,
			"sekuritas_order_id", resp.ID,
			"reject_reason", resp.RejectReason,
		)
		return
	}

	// Success
	bot.SetOpenOrderID(dec.ClientOrderID, resp.ID)

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
