package session

import (
	"context"
	"math/rand"
	"strings"
	"time"

	"mandala-exchange/mats/internal/domain"
	"mandala-exchange/mats/internal/events"
	"mandala-exchange/mats/internal/orders"
	"mandala-exchange/mats/internal/rules"
)

type Controller struct {
	rules      *rules.Cache
	orders     *orders.Service
	dispatcher *events.Dispatcher
}

func NewController(rulesCache *rules.Cache, orderService *orders.Service, dispatcher *events.Dispatcher) *Controller {
	return &Controller{
		rules:      rulesCache,
		orders:     orderService,
		dispatcher: dispatcher,
	}
}

func (c *Controller) SetStatus(ctx context.Context, status domain.SessionStatus) {
	_ = ctx
	c.rules.SetSessionStatus(status)
	c.Publish("", "session_state", map[string]any{
		"status":      status,
		"occurred_at": time.Now().UTC(),
	})
}

func (c *Controller) HaltMarket(ctx context.Context, reason string) {
	_ = ctx
	if reason == "" {
		reason = "manual_market_halt"
	}
	c.rules.SetSessionStatus(domain.SessionHalted)
	c.Publish("", "market_halt", map[string]any{
		"status":      "halted",
		"reason":      reason,
		"occurred_at": time.Now().UTC(),
	})
}

func (c *Controller) ResumeMarket(ctx context.Context, status domain.SessionStatus) {
	_ = ctx
	if status == "" || status == domain.SessionHalted {
		status = domain.SessionContinuous
	}
	c.rules.SetSessionStatus(status)
	c.Publish("", "market_halt", map[string]any{
		"status":      "resumed",
		"session":     status,
		"occurred_at": time.Now().UTC(),
	})
	c.Publish("", "session_state", map[string]any{
		"status":      status,
		"occurred_at": time.Now().UTC(),
	})
}

func (c *Controller) SuspendSymbol(ctx context.Context, symbol, reason string) {
	_ = ctx
	symbol = strings.ToUpper(strings.TrimSpace(symbol))
	if reason == "" {
		reason = "symbol_suspended"
	}
	c.rules.SuspendSymbol(symbol, reason)
	c.Publish(symbol, "market_halt", map[string]any{
		"symbol":      symbol,
		"status":      "suspended",
		"reason":      reason,
		"occurred_at": time.Now().UTC(),
	})
	c.Publish(symbol, "special_notation", map[string]any{
		"symbol":      symbol,
		"notations":   []string{"suspend"},
		"reason":      reason,
		"occurred_at": time.Now().UTC(),
	})
}

func (c *Controller) ResumeSymbol(ctx context.Context, symbol string) {
	_ = ctx
	symbol = strings.ToUpper(strings.TrimSpace(symbol))
	c.rules.ResumeSymbol(symbol)
	c.Publish(symbol, "market_halt", map[string]any{
		"symbol":      symbol,
		"status":      "resumed",
		"occurred_at": time.Now().UTC(),
	})
	c.Publish(symbol, "special_notation", map[string]any{
		"symbol":      symbol,
		"notations":   []string{},
		"occurred_at": time.Now().UTC(),
	})
}

func (c *Controller) StartRandomClosing(maxSeconds int) int {
	if maxSeconds < 0 {
		maxSeconds = 0
	}
	delaySeconds := 0
	if maxSeconds > 0 {
		delaySeconds = rand.New(rand.NewSource(time.Now().UnixNano())).Intn(maxSeconds + 1)
	}
	c.rules.SetSessionStatus(domain.SessionRandomClosing)
	c.Publish("", "session_state", map[string]any{
		"status":        domain.SessionRandomClosing,
		"delay_seconds": delaySeconds,
		"occurred_at":   time.Now().UTC(),
	})
	go func() {
		if delaySeconds > 0 {
			time.Sleep(time.Duration(delaySeconds) * time.Second)
		}
		c.rules.SetSessionStatus(domain.SessionClosingAuction)
		c.Publish("", "session_state", map[string]any{
			"status":      domain.SessionClosingAuction,
			"occurred_at": time.Now().UTC(),
		})
	}()
	return delaySeconds
}

func (c *Controller) Indicative(symbol string) domain.IndicativePriceVolume {
	return c.orders.Indicative(symbol)
}

func (c *Controller) UncrossAuction(ctx context.Context, symbol string) (domain.IndicativePriceVolume, []domain.Trade, []*domain.Order, error) {
	indicative, trades, updatedOrders, err := c.orders.UncrossAuction(ctx, symbol)
	if err != nil {
		return indicative, nil, nil, err
	}
	c.Publish(strings.ToUpper(strings.TrimSpace(symbol)), "auction_uncrossed", map[string]any{
		"indicative":  indicative,
		"trade_count": len(trades),
		"occurred_at": time.Now().UTC(),
	})
	return indicative, trades, updatedOrders, nil
}

func (c *Controller) ExpireOpenOrders(ctx context.Context) ([]*domain.Order, error) {
	expired, err := c.orders.ExpireOpenOrders(ctx)
	if err != nil {
		return nil, err
	}
	c.Publish("", "expired_orders", map[string]any{
		"count":       len(expired),
		"occurred_at": time.Now().UTC(),
	})
	return expired, nil
}

func (c *Controller) Publish(symbol, eventType string, payload any) {
	if c.dispatcher != nil {
		c.dispatcher.PublishMarketData(symbol, eventType, payload)
	}
}
