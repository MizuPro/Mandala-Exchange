package rules

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/redis/go-redis/v9"
	"mandala-exchange/mats/internal/matching"
)

type MarketUpdateEvent struct {
	Type      string          `json:"type"`
	Timestamp string          `json:"timestamp"`
	Payload   json.RawMessage `json:"payload"`
}

type Callbacks struct {
	OnSuspendSymbol func(ctx context.Context, symbol, reason string)
	OnMarketHalt    func(ctx context.Context, reason string)
}

type Subscriber struct {
	client    *redis.Client
	logger    *slog.Logger
	cache     *Cache
	engine    *matching.Engine
	callbacks Callbacks
}

func NewSubscriber(redisURL string, logger *slog.Logger, cache *Cache, engine *matching.Engine, callbacks Callbacks) (*Subscriber, error) {
	opts, err := redis.ParseURL(redisURL)
	if err != nil {
		return nil, err
	}
	client := redis.NewClient(opts)
	return &Subscriber{
		client:    client,
		logger:    logger,
		cache:     cache,
		engine:    engine,
		callbacks: callbacks,
	}, nil
}

func (s *Subscriber) Start(ctx context.Context) {
	pubsub := s.client.Subscribe(ctx, "market_updates")
	defer pubsub.Close()

	ch := pubsub.Channel()
	s.logger.Info("started redis subscriber for market_updates")

	for {
		select {
		case <-ctx.Done():
			s.logger.Info("stopping redis subscriber")
			return
		case msg := <-ch:
			if msg == nil {
				continue
			}
			var event MarketUpdateEvent
			if err := json.Unmarshal([]byte(msg.Payload), &event); err != nil {
				s.logger.Error("failed to unmarshal market update event", "error", err)
				continue
			}

			s.logger.Info("received market update", "type", event.Type)
			
			// Always refresh cache on any market update
			if err := s.cache.Refresh(ctx); err != nil {
				s.logger.Warn("sync from BEI failed after market update", "error", err)
			} else {
				s.engine.UpdateSessionID(s.cache.ActiveSessionID())
			}

			// Handle specific circuit breaker events
			if event.Type == "suspend_symbol" && s.callbacks.OnSuspendSymbol != nil {
				var payload struct {
					Symbol string `json:"symbol"`
					Reason string `json:"reason"`
				}
				if err := json.Unmarshal([]byte(event.Payload), &payload); err == nil {
					s.callbacks.OnSuspendSymbol(ctx, payload.Symbol, payload.Reason)
				}
			} else if event.Type == "market_halt" && s.callbacks.OnMarketHalt != nil {
				var payload struct {
					Reason string `json:"reason"`
				}
				if err := json.Unmarshal([]byte(event.Payload), &payload); err == nil {
					s.callbacks.OnMarketHalt(ctx, payload.Reason)
				}
			}
		}
	}
}

func (s *Subscriber) Close() error {
	return s.client.Close()
}
