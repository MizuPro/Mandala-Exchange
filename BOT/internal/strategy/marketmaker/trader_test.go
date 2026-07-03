package marketmaker

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Mandala-Exchange/BOT/internal/config"
	"github.com/Mandala-Exchange/BOT/internal/decision"
	"github.com/Mandala-Exchange/BOT/internal/marketrules"
	"github.com/Mandala-Exchange/BOT/internal/portfolio"
	"github.com/Mandala-Exchange/BOT/internal/queue"
	"github.com/Mandala-Exchange/BOT/internal/realism"
	"github.com/Mandala-Exchange/BOT/internal/scheduler"
	"github.com/Mandala-Exchange/BOT/internal/session"
)

func clearDB(t *testing.T, pool *pgxpool.Pool) {
	ctx := context.Background()
	_, err := pool.Exec(ctx, "TRUNCATE bots, config_versions, bot_decision_logs CASCADE")
	if err != nil {
		t.Fatalf("failed to truncate tables: %v", err)
	}
}

type noopRecorder struct {
	mu      sync.Mutex
	entries []decision.DecisionLog
}

func (r *noopRecorder) Record(_ context.Context, entry decision.DecisionLog) error {
	r.mu.Lock()
	r.entries = append(r.entries, entry)
	r.mu.Unlock()
	return nil
}

func (r *noopRecorder) all() []decision.DecisionLog {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]decision.DecisionLog, len(r.entries))
	copy(out, r.entries)
	return out
}

type staticClock struct {
	instance *session.SessionInstance
}

func (c staticClock) GetInstance() *session.SessionInstance            { return c.instance }
func (c staticClock) VirtualToRealDelay(d time.Duration) time.Duration { return d }
func (c staticClock) SessionProgress() float64                         { return 0.5 }

func activeClock() staticClock {
	return staticClock{
		instance: &session.SessionInstance{
			InstanceID:      uuid.New(),
			Status:          session.StateContinuous,
			VirtualDayIndex: 1,
		},
	}
}

func inactiveClock() staticClock {
	return staticClock{
		instance: &session.SessionInstance{
			InstanceID:      uuid.New(),
			Status:          session.StateClosed,
			VirtualDayIndex: 1,
		},
	}
}

func newTraderTestResolver(t *testing.T) *marketrules.SnapshotResolver {
	t.Helper()
	securitiesJSON := []byte(`[
		{"symbol":"BBCA","board":"RG","status":"listed","previous_close":10000,"last":10050}
	]`)
	rulesJSON := []byte(`[{
		"board":"RG",
		"lot_size_rules":[{"lot_size":100}],
		"tick_size_rules":[
			{"min_price":1,"max_price":9223372036854775807,"tick_size":25}
		],
		"price_band_rules":[{"ara_percent":0.35,"arb_percent":0.35}]
	}]`)
	feeJSON := []byte(`{
		"brokerBuyRate":"0.0015","brokerSellRate":"0.0025",
		"settlementFeeRate":"0.0003","guaranteeFundRate":"0.0001",
		"vatRate":"0.11","sellTaxRate":"0.001"
	}`)
	r, err := marketrules.NewSnapshotResolver(securitiesJSON, rulesJSON, feeJSON, time.Now())
	if err != nil {
		t.Fatalf("newTraderTestResolver: %v", err)
	}
	return r
}

func TestTrader_HandleTask_SessionClosed(t *testing.T) {
	dbPool := setupTestDBPool(t)
	defer dbPool.Close()

	clearDB(t, dbPool)

	rules := newTraderTestResolver(t)
	ruleStore := marketrules.NewStore()
	ruleStore.Update(rules)

	portStore := portfolio.NewStore()
	accID := "acc-mm-01"
	portStore.Replace(portfolio.Snapshot{
		Accounts: []portfolio.Account{
			{
				AccountID: accID,
				Cash:      portfolio.Cash{AvailableIDR: 100_000_000},
			},
		},
	})

	sched := scheduler.NewScheduler(1)
	// Publish market snapshot so it does not fail on snapshot lookups
	sched.Snapshots.Publish(scheduler.MarketSnapshot{
		Symbol: "BBCA", Price: 10000, LotSize: 100,
	})

	orderQ := queue.NewOrderQueue(1, 100)
	recorder := &noopRecorder{}

	configMgr := config.NewConfigManager(dbPool)
	botID := "mm-bot-01"
	botUUID := uuid.New()
	
	setupBotConfigInDB(t, dbPool, botID, "market_maker", map[string]interface{}{
		"symbol":                  "BBCA",
		"levels":                  3,
		"spread_ticks":            config.Distribution{Type: "fixed", Min: 2, Max: 2},
		"level_size_lots":         config.Distribution{Type: "fixed", Min: 5, Max: 5},
		"refresh_virtual_seconds": config.Distribution{Type: "fixed", Min: 30, Max: 30},
		"max_inventory_lots":      int64(100),
		"inventory_skew_strength": 0.5,
		"fee_aware":               false,
		"self_trade_prevention":   "cancel_newest",
	})

	tder := NewTrader(
		dbPool,
		configMgr,
		portStore,
		sched,
		realism.New(1),
		inactiveClock(),
		orderQ,
		ruleStore,
		func(bID string) string { return accID },
		func(bID string) *uuid.UUID { return &botUUID },
		nil,
		recorder,
	)

	ctx := context.Background()
	err := tder.HandleTask(ctx, botID, nil)
	if err != nil {
		t.Fatalf("expected nil error on inactive session hold: %v", err)
	}

	entries := recorder.all()
	if len(entries) == 0 {
		t.Fatal("expected decision logs to be recorded")
	}

	lastEntry := entries[len(entries)-1]
	if lastEntry.Action != decision.ActionHold || lastEntry.DecisionReason != "session_not_active_for_strategy" {
		t.Errorf("expected session hold decision, got action=%s reason=%s", lastEntry.Action, lastEntry.DecisionReason)
	}
}

func TestTrader_HandleTask_PlaceNewQuotes(t *testing.T) {
	dbPool := setupTestDBPool(t)
	defer dbPool.Close()

	clearDB(t, dbPool)

	rules := newTraderTestResolver(t)
	ruleStore := marketrules.NewStore()
	ruleStore.Update(rules)

	portStore := portfolio.NewStore()
	accID := "acc-mm-01"
	portStore.Replace(portfolio.Snapshot{
		Accounts: []portfolio.Account{
			{
				AccountID: accID,
				Cash:      portfolio.Cash{AvailableIDR: 1_000_000_000},
				Positions: []portfolio.Position{
					{
						Symbol:          "BBCA",
						AvailableShares: 50_000, // 500 lots initial inventory
					},
				},
			},
		},
	})

	sched := scheduler.NewScheduler(1)
	orderQ := queue.NewOrderQueue(1, 100)
	recorder := &noopRecorder{}

	configMgr := config.NewConfigManager(dbPool)
	botID := "mm-bot-01"
	botUUID := uuid.New()
	
	setupBotConfigInDB(t, dbPool, botID, "market_maker", map[string]interface{}{
		"symbol":                  "BBCA",
		"levels":                  2,
		"spread_ticks":            map[string]interface{}{"type": "fixed", "min": 2.0, "max": 2.0, "mean": 0.0, "stddev": 0.0},
		"level_size_lots":         map[string]interface{}{"type": "fixed", "min": 5.0, "max": 5.0, "mean": 0.0, "stddev": 0.0},
		"refresh_virtual_seconds": map[string]interface{}{"type": "fixed", "min": 30.0, "max": 30.0, "mean": 0.0, "stddev": 0.0},
		"max_inventory_lots":      1000,
		"inventory_skew_strength": 0.0,
		"fee_aware":               false,
		"self_trade_prevention":   "cancel_newest",
	})

	// Set market snapshot in scheduler store
	sched.Snapshots.Publish(scheduler.MarketSnapshot{
		Symbol: "BBCA",
		Price:  10000,
		Bids: []scheduler.BookLevel{
			{Price: 9975, Quantity: 1000},
		},
		Asks: []scheduler.BookLevel{
			{Price: 10025, Quantity: 1000},
		},
	})

	tder := NewTrader(
		dbPool,
		configMgr,
		portStore,
		sched,
		realism.New(1),
		activeClock(),
		orderQ,
		ruleStore,
		func(bID string) string { return accID },
		func(bID string) *uuid.UUID { return &botUUID },
		nil,
		recorder,
	)

	ctx := context.Background()
	err := tder.HandleTask(ctx, botID, nil)
	if err != nil {
		t.Fatalf("expected nil error, got %v", err)
	}

	acc, _ := portStore.Account(accID)
	if acc.Cash.ReservedIDR == 0 {
		t.Error("expected cash to be reserved for buy quotes")
	}
	
	bbcaPos := acc.Positions[0]
	if bbcaPos.ReservedShares == 0 {
		t.Error("expected positions to be reserved for sell quotes")
	}

	openLocalOrders := portStore.OpenLocalOrders(accID)
	if len(openLocalOrders) != 4 { // 2 bids + 2 asks
		t.Errorf("expected 4 open local orders tracked, got %d", len(openLocalOrders))
	}
}

func TestTrader_HandleTask_AmendAndCancelQuotes(t *testing.T) {
	dbPool := setupTestDBPool(t)
	defer dbPool.Close()

	clearDB(t, dbPool)

	rules := newTraderTestResolver(t)
	ruleStore := marketrules.NewStore()
	ruleStore.Update(rules)

	portStore := portfolio.NewStore()
	accID := "acc-mm-01"
	clockInst := activeClock()
	sessionID := clockInst.GetInstance().InstanceID

	// Seed existing open local orders to be amended/cancelled
	oldBidOrderID := fmt.Sprintf("bot:mm-bot-01:BBCA:mm:buy:0:%s:12345", sessionID.String())
	oldAskOrderID := fmt.Sprintf("bot:mm-bot-01:BBCA:mm:sell:0:%s:67890", sessionID.String())

	portStore.Replace(portfolio.Snapshot{
		Accounts: []portfolio.Account{
			{
				AccountID: accID,
				Cash:      portfolio.Cash{AvailableIDR: 900_000_000, ReservedIDR: 5_000_000},
				Positions: []portfolio.Position{
					{
						Symbol:          "BBCA",
						AvailableShares: 49_500,
						ReservedShares:  500,
					},
				},
				OpenOrders: []portfolio.OpenOrder{
					{
						OrderID:       "seq-old-bid",
						ClientOrderID: oldBidOrderID,
						Symbol:        "BBCA",
						Side:          "buy",
						Status:        "open",
						QuantityShares: 500,
					},
					{
						OrderID:       "seq-old-ask",
						ClientOrderID: oldAskOrderID,
						Symbol:        "BBCA",
						Side:          "sell",
						Status:        "open",
						QuantityShares: 500,
					},
				},
			},
		},
	})

	sched := scheduler.NewScheduler(1)
	orderQ := queue.NewOrderQueue(1, 100)
	recorder := &noopRecorder{}

	configMgr := config.NewConfigManager(dbPool)
	botID := "mm-bot-01"
	botUUID := uuid.New()
	
	setupBotConfigInDB(t, dbPool, botID, "market_maker", map[string]interface{}{
		"symbol":                  "BBCA",
		"levels":                  1,
		"spread_ticks":            map[string]interface{}{"type": "fixed", "min": 2.0, "max": 2.0, "mean": 0.0, "stddev": 0.0},
		"level_size_lots":         map[string]interface{}{"type": "fixed", "min": 5.0, "max": 5.0, "mean": 0.0, "stddev": 0.0},
		"refresh_virtual_seconds": map[string]interface{}{"type": "fixed", "min": 30.0, "max": 30.0, "mean": 0.0, "stddev": 0.0},
		"max_inventory_lots":      1000,
		"inventory_skew_strength": 0.0,
		"fee_aware":               false,
		"self_trade_prevention":   "cancel_newest",
	})

	sched.Snapshots.Publish(scheduler.MarketSnapshot{
		Symbol: "BBCA",
		Price:  10000,
		Bids: []scheduler.BookLevel{
			{Price: 9975, Quantity: 1000},
		},
		Asks: []scheduler.BookLevel{
			{Price: 10025, Quantity: 1000},
		},
	})

	tder := NewTrader(
		dbPool,
		configMgr,
		portStore,
		sched,
		realism.New(1),
		clockInst,
		orderQ,
		ruleStore,
		func(bID string) string { return accID },
		func(bID string) *uuid.UUID { return &botUUID },
		nil,
		recorder,
	)

	ctx := context.Background()
	err := tder.HandleTask(ctx, botID, nil)
	if err != nil {
		t.Fatalf("expected nil error, got %v", err)
	}

	_, ok1 := orderQ.LookupByClientID(oldBidOrderID + ":amend:1")
	if !ok1 {
		t.Error("expected amend order request in queue for old bid")
	}

	_, ok2 := orderQ.LookupByClientID(oldAskOrderID + ":amend:1")
	if !ok2 {
		t.Error("expected amend order request in queue for old ask")
	}
}

func TestTrader_HandleTask_SubmitUnknownHandling(t *testing.T) {
	dbPool := setupTestDBPool(t)
	defer dbPool.Close()

	clearDB(t, dbPool)

	rules := newTraderTestResolver(t)
	ruleStore := marketrules.NewStore()
	ruleStore.Update(rules)

	portStore := portfolio.NewStore()
	accID := "acc-mm-01"
	clockInst := activeClock()
	sessionID := clockInst.GetInstance().InstanceID

	unknownBidOrderID := fmt.Sprintf("bot:mm-bot-01:BBCA:mm:buy:0:%s:11111", sessionID.String())

	portStore.Replace(portfolio.Snapshot{
		Accounts: []portfolio.Account{
			{
				AccountID: accID,
				Cash:      portfolio.Cash{AvailableIDR: 900_000_000, ReservedIDR: 5_000_000},
				OpenOrders: []portfolio.OpenOrder{
					{
						OrderID:       "seq-unknown-bid",
						ClientOrderID: unknownBidOrderID,
						Symbol:        "BBCA",
						Side:          "buy",
						Status:        "submit_unknown",
						QuantityShares: 500,
					},
				},
			},
		},
	})

	sched := scheduler.NewScheduler(1)
	orderQ := queue.NewOrderQueue(1, 100)
	recorder := &noopRecorder{}

	configMgr := config.NewConfigManager(dbPool)
	botID := "mm-bot-01"
	botUUID := uuid.New()
	
	setupBotConfigInDB(t, dbPool, botID, "market_maker", map[string]interface{}{
		"symbol":                  "BBCA",
		"levels":                  1,
		"spread_ticks":            map[string]interface{}{"type": "fixed", "min": 2.0, "max": 2.0, "mean": 0.0, "stddev": 0.0},
		"level_size_lots":         map[string]interface{}{"type": "fixed", "min": 5.0, "max": 5.0, "mean": 0.0, "stddev": 0.0},
		"refresh_virtual_seconds": map[string]interface{}{"type": "fixed", "min": 30.0, "max": 30.0, "mean": 0.0, "stddev": 0.0},
		"max_inventory_lots":      1000,
		"inventory_skew_strength": 0.0,
		"fee_aware":               false,
		"self_trade_prevention":   "cancel_newest",
	})

	sched.Snapshots.Publish(scheduler.MarketSnapshot{
		Symbol: "BBCA",
		Price:  10000,
		Bids: []scheduler.BookLevel{
			{Price: 9975, Quantity: 1000},
		},
		Asks: []scheduler.BookLevel{
			{Price: 10025, Quantity: 1000},
		},
	})

	tder := NewTrader(
		dbPool,
		configMgr,
		portStore,
		sched,
		realism.New(1),
		clockInst,
		orderQ,
		ruleStore,
		func(bID string) string { return accID },
		func(bID string) *uuid.UUID { return &botUUID },
		nil,
		recorder,
	)

	ctx := context.Background()
	err := tder.HandleTask(ctx, botID, nil)
	if err != nil {
		t.Fatalf("expected nil error, got %v", err)
	}

	_, ok := orderQ.LookupByClientID(unknownBidOrderID + ":cancel:1")
	if !ok {
		t.Error("expected cancel order request in queue for submit_unknown bid")
	}
}

func setupTestDBPool(t *testing.T) *pgxpool.Pool {
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
		t.Skipf("skipping test; failed to connect to test db: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		t.Skipf("skipping test; failed to ping test db: %v", err)
	}
	return pool
}

func setupBotConfigInDB(t *testing.T, pool *pgxpool.Pool, botID, strategyType string, params map[string]interface{}) {
	ctx := context.Background()
	
	botCfg := config.BotConfig{
		ExternalBotID: botID,
		StrategyType:  strategyType,
		Risk:          config.DefaultRiskConfig(),
		Human:         config.DefaultHumanConfig(),
		Activity:      config.DefaultActivityConfig(),
		Parameters:    params,
	}
	
	configs := []config.BotConfig{botCfg}
	configData, err := json.Marshal(configs)
	if err != nil {
		t.Fatalf("failed to marshal configs: %v", err)
	}

	version := int64(1)
	_, err = pool.Exec(ctx, `
		INSERT INTO config_versions (version, description, config_data, source)
		VALUES ($1, 'test config', $2, 'database')
		ON CONFLICT (version) DO UPDATE SET config_data = EXCLUDED.config_data
	`, version, configData)
	if err != nil {
		t.Fatalf("failed to insert config_version: %v", err)
	}

	internalID := uuid.New()
	_, err = pool.Exec(ctx, `
		INSERT INTO bots (internal_id, external_bot_id, strategy_type, config_version, status)
		VALUES ($1, $2, $3, $4, 'inactive')
		ON CONFLICT (external_bot_id) DO UPDATE
		SET strategy_type = EXCLUDED.strategy_type, config_version = EXCLUDED.config_version
	`, internalID, botID, strategyType, version)
	if err != nil {
		t.Fatalf("failed to insert bot: %v", err)
	}
}
