package client_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Mandala-Exchange/BOT/internal/client/mats"
	"github.com/Mandala-Exchange/BOT/internal/config"
	"github.com/Mandala-Exchange/BOT/internal/decision"
	"github.com/Mandala-Exchange/BOT/internal/marketrules"
	"github.com/Mandala-Exchange/BOT/internal/portfolio"
	"github.com/Mandala-Exchange/BOT/internal/queue"
	"github.com/Mandala-Exchange/BOT/internal/realism"
	"github.com/Mandala-Exchange/BOT/internal/scheduler"
	"github.com/Mandala-Exchange/BOT/internal/session"
	"github.com/Mandala-Exchange/BOT/internal/strategy/marketmaker"
	"github.com/Mandala-Exchange/BOT/internal/strategy/momentum"
	"github.com/Mandala-Exchange/BOT/internal/strategy/noise"
)

type mockE2EClock struct {
	instance *session.SessionInstance
}

func (c mockE2EClock) GetInstance() *session.SessionInstance            { return c.instance }
func (c mockE2EClock) VirtualToRealDelay(d time.Duration) time.Duration { return d }
func (c mockE2EClock) SessionProgress() float64                         { return 0.5 }

type e2eDecisionRecorder struct {
	mu      sync.Mutex
	entries []decision.DecisionLog
}

func (r *e2eDecisionRecorder) Record(_ context.Context, entry decision.DecisionLog) error {
	r.mu.Lock()
	r.entries = append(r.entries, entry)
	r.mu.Unlock()
	return nil
}

func (r *e2eDecisionRecorder) all() []decision.DecisionLog {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]decision.DecisionLog, len(r.entries))
	copy(out, r.entries)
	return out
}

func setupE2EDB(t *testing.T) *pgxpool.Pool {
	databaseURL := os.Getenv("BOT_TEST_DATABASE_URL")
	if databaseURL == "" {
		databaseURL = "postgres://mandala_bot:secret@localhost:5435/mandala_bot_test?sslmode=disable"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err == nil {
		if err := pool.Ping(ctx); err == nil {
			return pool
		}
		pool.Close()
	}

	databaseURL = "postgres://mandala_bot:secret@localhost:5435/mandala_bot?sslmode=disable"
	pool, err = pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Skipf("skipping e2e test; failed to connect to test db: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		t.Skipf("skipping e2e test; failed to ping test db: %v", err)
	}
	return pool
}

func clearE2EDB(t *testing.T, pool *pgxpool.Pool) {
	ctx := context.Background()
	_, err := pool.Exec(ctx, "TRUNCATE bots, config_versions, bot_decision_logs CASCADE")
	if err != nil {
		t.Fatalf("failed to truncate tables: %v", err)
	}
}

func seed10Bots(t *testing.T, pool *pgxpool.Pool) (extIDs []string, accIDs []string) {
	ctx := context.Background()
	
	// Define 10 bots (3 MM, 4 Noise, 3 Momentum)
	botSpecs := []struct {
		id       string
		strategy string
		params   map[string]interface{}
	}{
		// 3 Market Makers
		{"e2e-mm-01", "market_maker", map[string]interface{}{
			"symbols_universe":        map[string]interface{}{"type": "all_active"},
			"levels":                  2,
			"spread_ticks":            config.Distribution{Type: "fixed", Min: 2, Max: 2},
			"level_size_lots":         config.Distribution{Type: "fixed", Min: 5, Max: 5},
			"refresh_virtual_seconds": config.Distribution{Type: "fixed", Min: 30, Max: 30},
			"max_inventory_lots":      int64(100),
			"inventory_skew_strength": 0.0,
			"fee_aware":               false,
			"self_trade_prevention":   "cancel_newest",
		}},
		{"e2e-mm-02", "market_maker", map[string]interface{}{
			"symbols_universe":        map[string]interface{}{"type": "all_active"},
			"levels":                  2,
			"spread_ticks":            config.Distribution{Type: "fixed", Min: 2, Max: 2},
			"level_size_lots":         config.Distribution{Type: "fixed", Min: 5, Max: 5},
			"refresh_virtual_seconds": config.Distribution{Type: "fixed", Min: 30, Max: 30},
			"max_inventory_lots":      int64(100),
			"inventory_skew_strength": 0.0,
			"fee_aware":               false,
			"self_trade_prevention":   "cancel_newest",
		}},
		{"e2e-mm-03", "market_maker", map[string]interface{}{
			"symbols_universe":        map[string]interface{}{"type": "all_active"},
			"levels":                  1,
			"spread_ticks":            config.Distribution{Type: "fixed", Min: 3, Max: 3},
			"level_size_lots":         config.Distribution{Type: "fixed", Min: 10, Max: 10},
			"refresh_virtual_seconds": config.Distribution{Type: "fixed", Min: 30, Max: 30},
			"max_inventory_lots":      int64(200),
			"inventory_skew_strength": 0.5,
			"fee_aware":               false,
			"self_trade_prevention":   "cancel_newest",
		}},
		// 4 Noise Traders
		{"e2e-noise-01", "noise_trader", map[string]interface{}{
			"symbols_universe": map[string]interface{}{"type": "all_active"},
			"buy_probability":  0.5,
			"order_size_lots":  config.Distribution{Type: "fixed", Min: 5, Max: 5},
			"price_deviation":  0.02,
			"decision_interval_virtual_minutes": config.Distribution{Type: "fixed", Min: 1, Max: 1},
		}},
		{"e2e-noise-02", "noise_trader", map[string]interface{}{
			"symbols_universe": map[string]interface{}{"type": "all_active"},
			"buy_probability":  0.3,
			"order_size_lots":  config.Distribution{Type: "fixed", Min: 2, Max: 2},
			"price_deviation":  0.01,
			"decision_interval_virtual_minutes": config.Distribution{Type: "fixed", Min: 2, Max: 2},
		}},
		{"e2e-noise-03", "noise_trader", map[string]interface{}{
			"symbols_universe": map[string]interface{}{"type": "all_active"},
			"buy_probability":  0.7,
			"order_size_lots":  config.Distribution{Type: "fixed", Min: 3, Max: 3},
			"price_deviation":  0.03,
			"decision_interval_virtual_minutes": config.Distribution{Type: "fixed", Min: 1, Max: 1},
		}},
		{"e2e-noise-04", "noise_trader", map[string]interface{}{
			"symbols_universe": map[string]interface{}{"type": "all_active"},
			"buy_probability":  0.5,
			"order_size_lots":  config.Distribution{Type: "fixed", Min: 4, Max: 4},
			"price_deviation":  0.015,
			"decision_interval_virtual_minutes": config.Distribution{Type: "fixed", Min: 1, Max: 1},
		}},
		// 3 Momentum Traders
		{"e2e-mom-01", "momentum_trader", map[string]interface{}{
			"lookback_virtual_minutes": map[string]interface{}{"type": "fixed", "min": 15, "max": 15, "mean": 0.0, "stddev": 0.0},
			"buy_trigger_pct":          map[string]interface{}{"type": "fixed", "min": 0.01, "max": 0.01, "mean": 0.0, "stddev": 0.0},
			"sell_trigger_pct":         map[string]interface{}{"type": "fixed", "min": -0.01, "max": -0.01, "mean": 0.0, "stddev": 0.0},
			"confirmation": map[string]interface{}{
				"minimum_trade_count":                 2,
				"minimum_persistence_virtual_seconds": 10,
				"require_volume_signal_probability":  0.0,
			},
			"entry_hysteresis_pct":     0.002,
			"cooldown_virtual_minutes": map[string]interface{}{"type": "fixed", "min": 5, "max": 5, "mean": 0.0, "stddev": 0.0},
			"order_size_lots":          map[string]interface{}{"type": "fixed", "min": 10, "max": 10, "mean": 0.0, "stddev": 0.0},
			"take_profit_pct":          0.05,
			"stop_loss_pct":            0.03,
		}},
		{"e2e-mom-02", "momentum_trader", map[string]interface{}{
			"lookback_virtual_minutes": map[string]interface{}{"type": "fixed", "min": 10, "max": 10, "mean": 0.0, "stddev": 0.0},
			"buy_trigger_pct":          map[string]interface{}{"type": "fixed", "min": 0.015, "max": 0.015, "mean": 0.0, "stddev": 0.0},
			"sell_trigger_pct":         map[string]interface{}{"type": "fixed", "min": -0.015, "max": -0.015, "mean": 0.0, "stddev": 0.0},
			"confirmation": map[string]interface{}{
				"minimum_trade_count":                 1,
				"minimum_persistence_virtual_seconds": 5,
				"require_volume_signal_probability":  0.0,
			},
			"entry_hysteresis_pct":     0.003,
			"cooldown_virtual_minutes": map[string]interface{}{"type": "fixed", "min": 10, "max": 10, "mean": 0.0, "stddev": 0.0},
			"order_size_lots":          map[string]interface{}{"type": "fixed", "min": 5, "max": 5, "mean": 0.0, "stddev": 0.0},
			"take_profit_pct":          0.04,
			"stop_loss_pct":            0.02,
		}},
		{"e2e-mom-03", "momentum_trader", map[string]interface{}{
			"lookback_virtual_minutes": map[string]interface{}{"type": "fixed", "min": 20, "max": 20, "mean": 0.0, "stddev": 0.0},
			"buy_trigger_pct":          map[string]interface{}{"type": "fixed", "min": 0.008, "max": 0.008, "mean": 0.0, "stddev": 0.0},
			"sell_trigger_pct":         map[string]interface{}{"type": "fixed", "min": -0.008, "max": -0.008, "mean": 0.0, "stddev": 0.0},
			"confirmation": map[string]interface{}{
				"minimum_trade_count":                 3,
				"minimum_persistence_virtual_seconds": 15,
				"require_volume_signal_probability":  0.0,
			},
			"entry_hysteresis_pct":     0.001,
			"cooldown_virtual_minutes": map[string]interface{}{"type": "fixed", "min": 5, "max": 5, "mean": 0.0, "stddev": 0.0},
			"order_size_lots":          map[string]interface{}{"type": "fixed", "min": 8, "max": 8, "mean": 0.0, "stddev": 0.0},
			"take_profit_pct":          0.03,
			"stop_loss_pct":            0.02,
		}},
	}

	for idx, spec := range botSpecs {
		extIDs = append(extIDs, spec.id)
		accUUID := uuid.New()
		accIDs = append(accIDs, accUUID.String())

		botCfg := config.BotConfig{
			ExternalBotID: spec.id,
			StrategyType:  spec.strategy,
			Risk:          config.DefaultRiskConfig(),
			Human:         config.DefaultHumanConfig(),
			Activity:      config.DefaultActivityConfig(),
			Parameters:    spec.params,
		}
		
		configs := []config.BotConfig{botCfg}
		configData, err := json.Marshal(configs)
		if err != nil {
			t.Fatalf("failed to marshal configs: %v", err)
		}

		version := int64(idx + 1)
		_, err = pool.Exec(ctx, `
			INSERT INTO config_versions (version, description, config_data, source)
			VALUES ($1, 'e2e config', $2, 'database')
			ON CONFLICT (version) DO UPDATE SET config_data = EXCLUDED.config_data
		`, version, configData)
		if err != nil {
			t.Fatalf("failed to insert config_version: %v", err)
		}

		internalID := uuid.New()
		_, err = pool.Exec(ctx, `
			INSERT INTO bots (internal_id, external_bot_id, strategy_type, config_version, status, sekuritas_account_id)
			VALUES ($1, $2, $3, $4, 'inactive', $5)
			ON CONFLICT (external_bot_id) DO UPDATE
			SET strategy_type = EXCLUDED.strategy_type, config_version = EXCLUDED.config_version, sekuritas_account_id = EXCLUDED.sekuritas_account_id
		`, internalID, spec.id, spec.strategy, version, accUUID)
		if err != nil {
			t.Fatalf("failed to insert bot: %v", err)
		}
	}
	return
}

func buildE2ETestResolver(t *testing.T) *marketrules.SnapshotResolver {
	t.Helper()
	securitiesJSON := []byte(`[
		{"symbol":"BBCA","board":"RG","status":"listed","previous_close":10000,"last":10050},
		{"symbol":"TLKM","board":"RG","status":"listed","previous_close":3000,"last":2990}
	]`)
	rulesJSON := []byte(`[{
		"board":"RG",
		"lot_size_rules":[{"lot_size":100}],
		"tick_size_rules":[
			{"min_price":1,"max_price":9223372036854775807,"tick_size":25}
		],
		"price_band_rules":[{"ara_percent":0.35,"arb_percent":-0.35}]
	}]`)
	feeJSON := []byte(`{
		"brokerBuyRate":"0.0015","brokerSellRate":"0.0025",
		"settlementFeeRate":"0.0003","guaranteeFundRate":"0.0001",
		"vatRate":"0.11","sellTaxRate":"0.001"
	}`)
	r, err := marketrules.NewSnapshotResolver(securitiesJSON, rulesJSON, feeJSON, time.Now())
	if err != nil {
		t.Fatalf("newE2ETestResolver: %v", err)
	}
	return r
}

func TestPhase4E2EMVP(t *testing.T) {
	dbPool := setupE2EDB(t)
	defer dbPool.Close()

	clearE2EDB(t, dbPool)
	extIDs, accIDs := seed10Bots(t, dbPool)

	// Setup portfolio snapshot with lots of cash and some base positions
	portStore := portfolio.NewStore()
	accounts := make([]portfolio.Account, len(accIDs))
	for i, id := range accIDs {
		accounts[i] = portfolio.Account{
			AccountID: id,
			Cash:      portfolio.Cash{AvailableIDR: 1_000_000_000},
			Positions: []portfolio.Position{
				{Symbol: "BBCA", AvailableShares: 50_000},
				{Symbol: "TLKM", AvailableShares: 100_000},
			},
		}
	}
	portStore.Replace(portfolio.Snapshot{
		AsOfSequence: 1,
		GeneratedAt:  time.Now(),
		Accounts:     accounts,
	})

	// Setup active market rules
	rules := buildE2ETestResolver(t)
	ruleStore := marketrules.NewStore()
	ruleStore.Update(rules)

	// Mock server for bursa & client
	var placeCount int64
	var amendCount int64
	var cancelCount int64

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/internal/bots/provision":
			// Generate standard provision response
			results := make([]interface{}, len(extIDs))
			for i := range extIDs {
				results[i] = map[string]string{
					"external_bot_id": extIDs[i],
					"status":          "created",
					"account_id":      accIDs[i],
				}
			}
			json.NewEncoder(w).Encode(map[string]interface{}{"results": results})
		case "/internal/bots/tokens":
			// Token fetch
			tokens := make([]interface{}, len(accIDs))
			for i, id := range accIDs {
				tokens[i] = map[string]interface{}{
					"account_id": id,
					"token":      "jwt-token-" + id,
					"issued_at":  time.Now(),
					"expires_at": time.Now().Add(1 * time.Hour),
				}
			}
			json.NewEncoder(w).Encode(map[string]interface{}{"tokens": tokens})
		case "/orders/place":
			atomic.AddInt64(&placeCount, 1)
			w.WriteHeader(http.StatusAccepted)
			json.NewEncoder(w).Encode(map[string]interface{}{
				"order_id": "ord-" + uuid.NewString(),
				"status":   "accepted",
			})
		case "/orders/amend":
			atomic.AddInt64(&amendCount, 1)
			w.WriteHeader(http.StatusAccepted)
			json.NewEncoder(w).Encode(map[string]interface{}{
				"order_id": "ord-" + uuid.NewString(),
				"status":   "accepted",
			})
		case "/orders/cancel":
			atomic.AddInt64(&cancelCount, 1)
			w.WriteHeader(http.StatusAccepted)
			json.NewEncoder(w).Encode(map[string]interface{}{
				"status": "cancelled",
			})
		default:
			w.WriteHeader(http.StatusOK)
		}
	}))
	defer ts.Close()

	// Initialize Scheduler and Clock
	sched := scheduler.NewScheduler(1)
	clock := mockE2EClock{
		instance: &session.SessionInstance{
			InstanceID:      uuid.New(),
			Status:          session.StateContinuous,
			VirtualDayIndex: 1,
		},
	}

	configMgr := config.NewConfigManager(dbPool)
	orderQ := queue.NewOrderQueue(1, 100)
	recorder := &e2eDecisionRecorder{}

	// Run OrderQueue processor
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var queuedRequests []*queue.OrderRequest
	var reqMu sync.Mutex
	go orderQ.Run(ctx, func(c context.Context, req *queue.OrderRequest) {
		reqMu.Lock()
		queuedRequests = append(queuedRequests, req)
		reqMu.Unlock()
	})

	// Initialize strategy traders
	lookupFunc := func(bID string) string {
		for i, id := range extIDs {
			if id == bID {
				return accIDs[i]
			}
		}
		return ""
	}
	idLookupFunc := func(bID string) *uuid.UUID {
		id := uuid.New()
		return &id
	}

	mmTrader := marketmaker.NewTrader(
		dbPool, configMgr, portStore, sched, realism.New(1), clock, orderQ, ruleStore,
		lookupFunc, idLookupFunc, nil, recorder,
	)
	noiseTrader := noise.NewTrader(
		configMgr, portStore, sched, realism.New(2), clock, orderQ, ruleStore,
		lookupFunc, idLookupFunc, nil, recorder,
	)
	momTrader := momentum.NewTrader(
		dbPool, configMgr, portStore, sched, realism.New(3), clock, orderQ, ruleStore,
		lookupFunc, idLookupFunc, nil, recorder, nil,
	)

	// Publish current market price to build scheduler cache
	sched.Snapshots.Publish(scheduler.MarketSnapshot{
		Symbol: "BBCA", Price: 10000, LotSize: 100,
		Bids: []scheduler.BookLevel{{Price: 9975, Quantity: 1000}},
		Asks: []scheduler.BookLevel{{Price: 10025, Quantity: 1000}},
	})
	sched.Snapshots.Publish(scheduler.MarketSnapshot{
		Symbol: "TLKM", Price: 3000, LotSize: 100,
		Bids: []scheduler.BookLevel{{Price: 2980, Quantity: 2000}},
		Asks: []scheduler.BookLevel{{Price: 3000, Quantity: 2000}},
	})

	// Execute HandleTask for all bots to simulate first session tick
	for _, botID := range extIDs {
		// Detect strategy type
		var strat string
		err := dbPool.QueryRow(ctx, "SELECT strategy_type FROM bots WHERE external_bot_id = $1", botID).Scan(&strat)
		if err != nil {
			t.Fatalf("failed to query strategy: %v", err)
		}

		var handlerErr error
		switch strat {
		case "market_maker":
			handlerErr = mmTrader.HandleTask(ctx, botID, nil)
		case "noise_trader":
			handlerErr = noiseTrader.HandleTask(ctx, botID, nil)
		case "momentum_trader":
			// Seed lookback points to satisfy warmup period
			for offset := 20; offset >= 0; offset-- {
				momTrader.OnMarketEvent(mats.Event{
					Symbol: "BBCA",
					Type:   "last_price",
					Payload: json.RawMessage(fmt.Sprintf(`{"last":%d}`, 10000+offset*10)),
					OccurredAt: time.Now().Add(time.Duration(-offset) * time.Minute),
				})
			}
			handlerErr = momTrader.HandleTask(ctx, botID, nil)
		}

		if handlerErr != nil {
			t.Fatalf("bot %s HandleTask returned error: %v", botID, handlerErr)
		}
	}

	// Give a moment for goroutines to populate queue
	time.Sleep(100 * time.Millisecond)

	reqMu.Lock()
	qLen := len(queuedRequests)
	reqMu.Unlock()

	if qLen == 0 {
		t.Error("expected orders in queue, got 0")
	}

	// Verify pre-reservation was recorded and applied successfully
	var totalReservedCash int64
	var totalReservedShares int64
	for _, id := range accIDs {
		acc, _ := portStore.Account(id)
		totalReservedCash += acc.Cash.ReservedIDR
		for _, pos := range acc.Positions {
			totalReservedShares += pos.ReservedShares
		}
	}

	if totalReservedCash == 0 && totalReservedShares == 0 {
		t.Error("expected cash or share reservations to be non-zero after trader ticks")
	}

	// Verify decision records were stored in memory recorder
	entries := recorder.all()
	if len(entries) == 0 {
		t.Fatal("expected decision logs to be recorded")
	}

	// Safety: Verify self-trade prevention invariant (no bot matches its own order)
	for _, entry := range entries {
		if entry.Strategy == "market_maker" && entry.Action == decision.ActionPlaceOrder {
			if bids, ok := entry.ContextSnapshot["bids"].([]interface{}); ok && len(bids) > 0 {
				if asks, ok := entry.ContextSnapshot["asks"].([]interface{}); ok && len(asks) > 0 {
					bidPrice := int64(bids[0].(map[string]interface{})["price"].(float64))
					askPrice := int64(asks[0].(map[string]interface{})["price"].(float64))
					if bidPrice >= askPrice {
						t.Errorf("STP collision: bidPrice %d >= askPrice %d", bidPrice, askPrice)
					}
				}
			}
		}
	}
}
