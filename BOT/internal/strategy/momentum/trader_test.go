package momentum

import (
	"context"
	"encoding/json"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Mandala-Exchange/BOT/internal/antipredict"
	"github.com/Mandala-Exchange/BOT/internal/client/mats"
	"github.com/Mandala-Exchange/BOT/internal/config"
	"github.com/Mandala-Exchange/BOT/internal/decision"
	"github.com/Mandala-Exchange/BOT/internal/marketrules"
	"github.com/Mandala-Exchange/BOT/internal/portfolio"
	"github.com/Mandala-Exchange/BOT/internal/queue"
	"github.com/Mandala-Exchange/BOT/internal/realism"
	"github.com/Mandala-Exchange/BOT/internal/scheduler"
	"github.com/Mandala-Exchange/BOT/internal/session"
)

type mockDecisionRecorder struct {
	mu      sync.Mutex
	records []decision.DecisionLog
}

func (m *mockDecisionRecorder) Record(ctx context.Context, entry decision.DecisionLog) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.records = append(m.records, entry)
	return nil
}

func (m *mockDecisionRecorder) Records() []decision.DecisionLog {
	m.mu.Lock()
	defer m.mu.Unlock()
	copied := make([]decision.DecisionLog, len(m.records))
	copy(copied, m.records)
	return copied
}

type mockSessionClock struct {
	instance *session.SessionInstance
}

func (m *mockSessionClock) GetInstance() *session.SessionInstance {
	return m.instance
}

func (m *mockSessionClock) VirtualToRealDelay(d time.Duration) time.Duration {
	if m.instance == nil || m.instance.VirtualDurationSecs == 0 {
		return d
	}
	ratio := float64(m.instance.RealDurationSecs) / float64(m.instance.VirtualDurationSecs)
	return time.Duration(float64(d.Nanoseconds()) * ratio)
}

func (m *mockSessionClock) SessionProgress() float64 {
	return 0.5
}

func TestTrader_WarmupAndLookback(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	// Initial setup
	dbPool := setupTestDBPool(t)
	defer dbPool.Close()

	configMgr := config.NewConfigManager(dbPool)
	portStore := portfolio.NewStore()

	// Register Bot & Config
	botID := "bot-test-momentum"
	accountID := "acc-test"
	setupBotConfigInDB(t, dbPool, botID, "momentum_trader", map[string]interface{}{
		"lookback_virtual_minutes": config.Distribution{Type: "fixed", Min: 15, Max: 15},
		"buy_trigger_pct":          config.Distribution{Type: "fixed", Min: 0.015, Max: 0.015},
		"sell_trigger_pct":         config.Distribution{Type: "fixed", Min: -0.015, Max: -0.015},
		"confirmation": map[string]interface{}{
			"minimum_trade_count":                 3,
			"minimum_persistence_virtual_seconds": 15,
			"require_volume_signal_probability":  1.0,
		},
		"entry_hysteresis_pct":      0.003,
		"cooldown_virtual_minutes":  config.Distribution{Type: "fixed", Min: 10, Max: 10},
		"order_size_lots":           config.Distribution{Type: "fixed", Min: 5, Max: 5},
		"take_profit_pct":           0.03,
		"stop_loss_pct":            0.02,
	})

	sched := scheduler.NewScheduler(1)
	engine := realism.New(12345)
	sessID := uuid.New()
	sessClock := &mockSessionClock{
		instance: &session.SessionInstance{
			InstanceID:          sessID,
			VirtualDayIndex:     1,
			VirtualDurationSecs: 3600,
			RealDurationSecs:    360, // 10x compression
			Status:              session.StateContinuous,
		},
	}
	orderQ := queue.NewOrderQueue(1, 100)
	ruleStore := marketrules.NewStore()

	// Set active rules
	rules := setupMockRules()
	ruleStore.Update(rules)

	// Publish base price
	sched.Snapshots.Publish(scheduler.MarketSnapshot{
		Symbol: "BBCA", Price: 10000, LotSize: 100,
	})

	seeder, _ := antipredict.NewSeeder([]byte("secret-seed-here"), "test-app")
	decLog := &mockDecisionRecorder{}

	trader := NewTrader(
		dbPool, configMgr, portStore, sched, engine, sessClock, orderQ, ruleStore,
		func(id string) string { return accountID },
		func(id string) *uuid.UUID { idVal := uuid.New(); return &idVal },
		seeder, decLog, nil,
	)

	// CASE 1: Warmup phase. elapsed < lookback.
	// lookback = 15 min virtual = 90 sec real (with 10x compression)
	trader.botBootTimes[botID] = time.Now()
	err := trader.HandleTask(ctx, botID, nil)
	if err != nil {
		t.Fatalf("HandleTask returned error: %v", err)
	}

	records := decLog.Records()
	if len(records) == 0 {
		t.Fatal("no decision logged")
	}
	lastDec := records[len(records)-1]
	if lastDec.Action != decision.ActionHold || lastDec.DecisionReason != "warm_up_insufficient_history" {
		t.Errorf("expected hold due to warmup, got: %s (%s)", lastDec.Action, lastDec.DecisionReason)
	}

	// CASE 2: Set boot time in the past to pass warmup.
	trader.botBootTimes[botID] = time.Now().Add(-100 * time.Second)

	// Clean log records
	decLog.mu.Lock()
	decLog.records = nil
	decLog.mu.Unlock()

	// If history is empty, it should hold on "insufficient_trade_count"
	err = trader.HandleTask(ctx, botID, nil)
	if err != nil {
		t.Fatalf("HandleTask returned error: %v", err)
	}
	records = decLog.Records()
	lastDec = records[len(records)-1]
	if lastDec.Action != decision.ActionHold || lastDec.DecisionReason != "insufficient_trade_count" {
		t.Errorf("expected hold due to trade count, got: %s (%s)", lastDec.Action, lastDec.DecisionReason)
	}

	// CASE 3: Add history points that trigger BUY signal.
	// Buy trigger = 1.5%. 10000 -> 10200 (+2.0%)
	now := time.Now()
	trader.OnMarketEvent(mats.Event{
		Symbol:     "BBCA",
		Type:       "last_price",
		OccurredAt: now.Add(-60 * time.Second),
		Payload:    json.RawMessage(`{"last":10000}`),
	})
	trader.OnMarketEvent(mats.Event{
		Symbol:     "BBCA",
		Type:       "last_price",
		OccurredAt: now.Add(-30 * time.Second),
		Payload:    json.RawMessage(`{"last":10100}`),
	})
	trader.OnMarketEvent(mats.Event{
		Symbol:     "BBCA",
		Type:       "last_price",
		OccurredAt: now,
		Payload:    json.RawMessage(`{"last":10200}`),
	})

	// Refresh price in snapshot store
	sched.Snapshots.Publish(scheduler.MarketSnapshot{
		Symbol: "BBCA", Price: 10200, LotSize: 100,
	})

	// Seed Cash to Bot Account so it can BUY
	portStore.Replace(portfolio.Snapshot{
		AsOfSequence: 1,
		GeneratedAt:  time.Now(),
		Accounts: []portfolio.Account{
			{
				AccountID: accountID,
				Cash: portfolio.Cash{
					AvailableIDR: 10_000_000,
				},
			},
		},
	})

	decLog.mu.Lock()
	decLog.records = nil
	decLog.mu.Unlock()

	err = trader.HandleTask(ctx, botID, nil)
	if err != nil {
		t.Fatalf("HandleTask returned error: %v", err)
	}

	records = decLog.Records()
	var hasPlace bool
	for _, r := range records {
		if r.Action == decision.ActionPlaceOrder {
			hasPlace = true
			if *r.OrderQuantity != 500 { // 5 lots * 100 shares = 500
				t.Errorf("expected place qty 500, got: %d", *r.OrderQuantity)
			}
		}
	}
	if !hasPlace {
		t.Errorf("expected buy order to be placed under trend conditions, logs: %+v", records)
	}
}

func TestTrader_ExitStopLossAndTakeProfit(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	dbPool := setupTestDBPool(t)
	defer dbPool.Close()

	configMgr := config.NewConfigManager(dbPool)
	portStore := portfolio.NewStore()

	botID := "bot-test-exit"
	accountID := "acc-test"
	setupBotConfigInDB(t, dbPool, botID, "momentum_trader", map[string]interface{}{
		"take_profit_pct": 0.03,
		"stop_loss_pct":  0.02,
	})

	sched := scheduler.NewScheduler(1)
	engine := realism.New(12345)
	sessClock := &mockSessionClock{
		instance: &session.SessionInstance{
			InstanceID:          uuid.New(),
			VirtualDayIndex:     1,
			VirtualDurationSecs: 3600,
			RealDurationSecs:    360,
			Status:              session.StateContinuous,
		},
	}
	orderQ := queue.NewOrderQueue(1, 100)
	ruleStore := marketrules.NewStore()
	ruleStore.Update(setupMockRules())

	decLog := &mockDecisionRecorder{}
	seeder, _ := antipredict.NewSeeder([]byte("secret-seed-here"), "test-app")

	trader := NewTrader(
		dbPool, configMgr, portStore, sched, engine, sessClock, orderQ, ruleStore,
		func(id string) string { return accountID },
		func(id string) *uuid.UUID { idVal := uuid.New(); return &idVal },
		seeder, decLog, nil,
	)

	// Set bot position: holds 100 shares of BBCA bought at average price 10000.
	portStore.Replace(portfolio.Snapshot{
		AsOfSequence: 1,
		GeneratedAt:  time.Now(),
		Accounts: []portfolio.Account{
			{
				AccountID: accountID,
				Cash: portfolio.Cash{
					AvailableIDR: 10_000_000,
				},
				Positions: []portfolio.Position{
					{
						Symbol:          "BBCA",
						AvailableShares: 100,
						AveragePriceIDR: 10000,
						TotalCostIDR:    10000 * 100,
					},
				},
			},
		},
	})

	// CASE 1: Current price is 9700. Loss is -3.0%.
	// Stop loss trigger is 2.0% (-0.02). Stop loss exit should trigger.
	sched.Snapshots.Publish(scheduler.MarketSnapshot{
		Symbol: "BBCA", Price: 9700, LotSize: 100,
	})

	err := trader.HandleTask(ctx, botID, nil)
	if err != nil {
		t.Fatalf("HandleTask error: %v", err)
	}

	records := decLog.Records()
	var exitTriggered bool
	for _, r := range records {
		if r.Action == decision.ActionPlaceOrder {
			if r.ContextSnapshot != nil {
				if reason, ok := r.ContextSnapshot["exit_reason"]; ok && reason == "stop_loss" {
					exitTriggered = true
				}
			}
		}
	}
	if !exitTriggered {
		t.Errorf("expected stop loss exit, got: %+v", records)
	}

	// CASE 2: Current price is 10400. Profit is +4.0%.
	// Take profit trigger is 3.0% (0.03). Take profit exit should trigger.
	decLog.mu.Lock()
	decLog.records = nil
	decLog.mu.Unlock()

	sched.Snapshots.Publish(scheduler.MarketSnapshot{
		Symbol: "BBCA", Price: 10400, LotSize: 100,
	})

	err = trader.HandleTask(ctx, botID, nil)
	if err != nil {
		t.Fatalf("HandleTask error: %v", err)
	}

	records = decLog.Records()
	exitTriggered = false
	for _, r := range records {
		if r.Action == decision.ActionPlaceOrder {
			if r.ContextSnapshot != nil {
				if reason, ok := r.ContextSnapshot["exit_reason"]; ok && reason == "take_profit" {
					exitTriggered = true
				}
			}
		}
	}
	if !exitTriggered {
		t.Errorf("expected take profit exit, got: %+v", records)
	}
}


func TestTrader_DeterministicReplay(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	dbPool := setupTestDBPool(t)
	defer dbPool.Close()

	configMgr := config.NewConfigManager(dbPool)
	portStore := portfolio.NewStore()

	botID := "bot-test-deterministic"
	accountID := "acc-test"
	setupBotConfigInDB(t, dbPool, botID, "momentum_trader", map[string]interface{}{
		"lookback_virtual_minutes": config.Distribution{Type: "fixed", Min: 15, Max: 15},
		"buy_trigger_pct":          config.Distribution{Type: "fixed", Min: 0.015, Max: 0.015},
		"sell_trigger_pct":         config.Distribution{Type: "fixed", Min: -0.015, Max: -0.015},
	})

	sched := scheduler.NewScheduler(1)
	engine := realism.New(12345)
	sessClock := &mockSessionClock{
		instance: &session.SessionInstance{
			InstanceID:          uuid.New(),
			VirtualDayIndex:     1,
			VirtualDurationSecs: 3600,
			RealDurationSecs:    360,
			Status:              session.StateContinuous,
		},
	}
	orderQ := queue.NewOrderQueue(1, 100)
	ruleStore := marketrules.NewStore()
	ruleStore.Update(setupMockRules())

	decLog1 := &mockDecisionRecorder{}
	seeder, _ := antipredict.NewSeeder([]byte("secret-seed-here"), "test-app")

	trader1 := NewTrader(
		dbPool, configMgr, portStore, sched, engine, sessClock, orderQ, ruleStore,
		func(id string) string { return accountID },
		func(id string) *uuid.UUID { idVal := uuid.New(); return &idVal },
		seeder, decLog1, nil,
	)

	// Feed history
	now := time.Now()
	for i := 0; i < 20; i++ {
		trader1.OnMarketEvent(mats.Event{
			Symbol:     "BBCA",
			Type:       "last_price",
			OccurredAt: now.Add(-time.Duration(20-i) * time.Minute),
			Payload:    json.RawMessage(`{"last":10000}`),
		})
	}

	trader1.botBootTimes[botID] = now.Add(-10 * time.Hour)
	sched.Snapshots.Publish(scheduler.MarketSnapshot{
		Symbol: "BBCA", Price: 10000, LotSize: 100,
	})

	err := trader1.HandleTask(ctx, botID, nil)
	if err != nil {
		t.Fatalf("HandleTask error: %v", err)
	}

	// Repeat with trader2
	decLog2 := &mockDecisionRecorder{}
	trader2 := NewTrader(
		dbPool, configMgr, portStore, sched, engine, sessClock, orderQ, ruleStore,
		func(id string) string { return accountID },
		func(id string) *uuid.UUID { idVal := uuid.New(); return &idVal },
		seeder, decLog2, nil,
	)
	for i := 0; i < 20; i++ {
		trader2.OnMarketEvent(mats.Event{
			Symbol:     "BBCA",
			Type:       "last_price",
			OccurredAt: now.Add(-time.Duration(20-i) * time.Minute),
			Payload:    json.RawMessage(`{"last":10000}`),
		})
	}
	trader2.botBootTimes[botID] = now.Add(-10 * time.Hour)

	err = trader2.HandleTask(ctx, botID, nil)
	if err != nil {
		t.Fatalf("HandleTask error: %v", err)
	}

	r1 := decLog1.Records()
	r2 := decLog2.Records()
	if len(r1) != len(r2) {
		t.Errorf("Expected identical decision counts, got %d and %d", len(r1), len(r2))
	}
	for i := range r1 {
		if r1[i].Action != r2[i].Action || r1[i].DecisionReason != r2[i].DecisionReason {
			t.Errorf("Mismatch at index %d: %+v vs %+v", i, r1[i], r2[i])
		}
	}
}

func TestTrader_NoLookahead(t *testing.T) {
	dbPool := setupTestDBPool(t)
	defer dbPool.Close()

	configMgr := config.NewConfigManager(dbPool)
	portStore := portfolio.NewStore()
	accountID := "acc-test"

	sched := scheduler.NewScheduler(1)
	engine := realism.New(12345)
	sessClock := &mockSessionClock{
		instance: &session.SessionInstance{
			InstanceID:          uuid.New(),
			VirtualDayIndex:     1,
			VirtualDurationSecs: 3600,
			Status:              session.StateContinuous,
		},
	}
	orderQ := queue.NewOrderQueue(1, 100)
	ruleStore := marketrules.NewStore()
	ruleStore.Update(setupMockRules())
	decLog := &mockDecisionRecorder{}
	seeder, _ := antipredict.NewSeeder([]byte("secret-seed-here"), "test-app")

	trader := NewTrader(
		dbPool, configMgr, portStore, sched, engine, sessClock, orderQ, ruleStore,
		func(id string) string { return accountID },
		func(id string) *uuid.UUID { idVal := uuid.New(); return &idVal },
		seeder, decLog, nil,
	)

	// Feed future event (lookahead candidate)
	trader.OnMarketEvent(mats.Event{
		Symbol:     "BBCA",
		Type:       "last_price",
		OccurredAt: time.Now().Add(1 * time.Hour), // 1 hour in the future!
		Payload:    json.RawMessage(`{"last":15000}`),
	})

	// Get points within window
	trader.historyMu.RLock()
	pts := trader.history["BBCA"]
	trader.historyMu.RUnlock()

	now := time.Now()
	var window []PricePoint
	for _, p := range pts {
		if p.OccurredAt.After(now) {
			continue // No-lookahead
		}
		window = append(window, p)
	}

	if len(window) > 0 {
		t.Errorf("expected 0 points due to future lookahead check, got %d", len(window))
	}
}

func TestTrader_RestartRecoveryAndSubmitUnknown(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	dbPool := setupTestDBPool(t)
	defer dbPool.Close()

	configMgr := config.NewConfigManager(dbPool)
	portStore := portfolio.NewStore()

	botID := "bot-test-recovery"
	accountID := "acc-test"
	setupBotConfigInDB(t, dbPool, botID, "momentum_trader", map[string]interface{}{
		"cooldown_virtual_minutes": config.Distribution{Type: "fixed", Min: 10, Max: 10},
	})

	sched := scheduler.NewScheduler(1)
	engine := realism.New(12345)
	sessClock := &mockSessionClock{
		instance: &session.SessionInstance{
			InstanceID:          uuid.New(),
			VirtualDayIndex:     1,
			VirtualDurationSecs: 3600,
			RealDurationSecs:    360,
			Status:              session.StateContinuous,
		},
	}
	orderQ := queue.NewOrderQueue(1, 100)
	ruleStore := marketrules.NewStore()
	ruleStore.Update(setupMockRules())

	decLog := &mockDecisionRecorder{}
	seeder, _ := antipredict.NewSeeder([]byte("secret-seed-here"), "test-app")

	trader := NewTrader(
		dbPool, configMgr, portStore, sched, engine, sessClock, orderQ, ruleStore,
		func(id string) string { return accountID },
		func(id string) *uuid.UUID { idVal := uuid.New(); return &idVal },
		seeder, decLog, nil,
	)

	// 1. Verify submit_unknown is scheduled for cancel during recovery
	clientOrderID := "client-order-unknown-1"
	portStore.Replace(portfolio.Snapshot{
		AsOfSequence: 1,
		GeneratedAt:  time.Now(),
		Accounts: []portfolio.Account{
			{
				AccountID: accountID,
				Cash: portfolio.Cash{
					AvailableIDR: 10_000_000,
				},
				OpenOrders: []portfolio.OpenOrder{
					{
						ClientOrderID: clientOrderID,
						Symbol:        "BBCA",
						Side:          "buy",
						Status:        "submit_unknown",
					},
				},
			},
		},
	})

	trader.scheduleRecoveredCancels(botID, Config{
		CooldownVirtualMinutes: config.Distribution{Type: "fixed", Min: 10, Max: 10},
	})

	trader.rngMu.Lock()
	_, scheduled := trader.cancelScheduled[clientOrderID]
	trader.rngMu.Unlock()
	if !scheduled {
		t.Errorf("expected submit_unknown order to be scheduled for cancel")
	}

	// 2. Verify cooldown database recovery
	// Insert a dummy place_order decision log for this bot
	botUUID := uuid.New()
	_, err := dbPool.Exec(ctx, `
		INSERT INTO bot_decision_logs (internal_id, strategy, symbol, action, decision_reason, created_at)
		VALUES ($1, 'momentum_trader', 'BBCA', 'place_order', 'buy_signal', $2)
	`, botUUID, time.Now().Add(-1*time.Minute))
	if err != nil {
		t.Fatalf("failed to insert mock decision log: %v", err)
	}

	err = trader.recoverCooldownsFromDB(ctx, botID, &botUUID, Config{
		CooldownVirtualMinutes: config.Distribution{Type: "fixed", Min: 10, Max: 10},
	})
	if err != nil {
		t.Fatalf("recoverCooldownsFromDB returned error: %v", err)
	}

	trader.rngMu.Lock()
	until, hasCooldown := trader.cooldowns[botID]["BBCA"]
	trader.rngMu.Unlock()

	if !hasCooldown {
		t.Errorf("expected cooldown to be recovered from database decision logs")
	}
	if !time.Now().Before(until) {
		t.Errorf("expected recovered cooldown to be active, cooldown until: %v", until)
	}
}

func TestTrader_RaceOnMarketEvent(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	dbPool := setupTestDBPool(t)
	defer dbPool.Close()

	configMgr := config.NewConfigManager(dbPool)
	portStore := portfolio.NewStore()
	botID := "bot-test-race"
	accountID := "acc-test"

	sched := scheduler.NewScheduler(1)
	engine := realism.New(12345)
	sessClock := &mockSessionClock{
		instance: &session.SessionInstance{
			InstanceID:          uuid.New(),
			VirtualDayIndex:     1,
			VirtualDurationSecs: 3600,
			Status:              session.StateContinuous,
		},
	}
	orderQ := queue.NewOrderQueue(1, 100)
	ruleStore := marketrules.NewStore()
	ruleStore.Update(setupMockRules())
	decLog := &mockDecisionRecorder{}
	seeder, _ := antipredict.NewSeeder([]byte("secret-seed-here"), "test-app")

	trader := NewTrader(
		dbPool, configMgr, portStore, sched, engine, sessClock, orderQ, ruleStore,
		func(id string) string { return accountID },
		func(id string) *uuid.UUID { idVal := uuid.New(); return &idVal },
		seeder, decLog, nil,
	)

	var wg sync.WaitGroup
	wg.Add(2)

	// Goroutine 1: Continuous OnMarketEvent
	go func() {
		defer wg.Done()
		for i := 0; i < 500; i++ {
			trader.OnMarketEvent(mats.Event{
				Symbol:     "BBCA",
				Type:       "last_price",
				OccurredAt: time.Now(),
				Payload:    json.RawMessage(`{"last":10000}`),
			})
		}
	}()

	// Goroutine 2: Continuous HandleTask
	go func() {
		defer wg.Done()
		for i := 0; i < 20; i++ {
			_ = trader.HandleTask(ctx, botID, nil)
		}
	}()

	wg.Wait()
}

func TestTrader_QueueFullAndExpiry(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	dbPool := setupTestDBPool(t)
	defer dbPool.Close()

	configMgr := config.NewConfigManager(dbPool)
	portStore := portfolio.NewStore()
	botID := "bot-test-queue-full"
	accountID := "acc-test"
	setupBotConfigInDB(t, dbPool, botID, "momentum_trader", map[string]interface{}{})

	sched := scheduler.NewScheduler(1)
	engine := realism.New(12345)
	sessClock := &mockSessionClock{
		instance: &session.SessionInstance{
			InstanceID:          uuid.New(),
			VirtualDayIndex:     1,
			VirtualDurationSecs: 3600,
			Status:              session.StateContinuous,
		},
	}
	
	// Create queue with capacity 0 (always full)
	orderQ := queue.NewOrderQueue(1, 0)
	ruleStore := marketrules.NewStore()
	ruleStore.Update(setupMockRules())
	decLog := &mockDecisionRecorder{}
	seeder, _ := antipredict.NewSeeder([]byte("secret-seed-here"), "test-app")

	trader := NewTrader(
		dbPool, configMgr, portStore, sched, engine, sessClock, orderQ, ruleStore,
		func(id string) string { return accountID },
		func(id string) *uuid.UUID { idVal := uuid.New(); return &idVal },
		seeder, decLog, nil,
	)

	// Invoke handleDelayedSubmit manually to verify it records "queue_submit_failed"
	dayIndex := int64(sessClock.instance.VirtualDayIndex)
	payload := delayedSubmitPayload{
		BotID:             botID,
		AccountID:         accountID,
		Symbol:            "BBCA",
		Side:              "buy",
		PriceIDR:          10000,
		QuantityShares:    100,
		ClientOrderID:     "test-order-q-full",
		SessionInstanceID: &sessClock.instance.InstanceID,
		VirtualDayIndex:   &dayIndex,
		SessionStatus:     string(sessClock.instance.Status),
		InternalID:        func() *uuid.UUID { idVal := uuid.New(); return &idVal }(),
	}

	err := trader.handleDelayedSubmit(ctx, botID, payload)
	if err != nil {
		t.Fatalf("handleDelayedSubmit returned error: %v", err)
	}

	records := decLog.Records()
	var hasQFailed bool
	for _, r := range records {
		if r.Action == decision.ActionReject && r.DecisionReason == "queue_submit_failed" {
			hasQFailed = true
		}
	}

	if !hasQFailed {
		t.Errorf("expected queue_submit_failed record in decision log, got: %+v", records)
	}
}

func TestTrader_InactiveSessionHold(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	dbPool := setupTestDBPool(t)
	defer dbPool.Close()

	configMgr := config.NewConfigManager(dbPool)
	portStore := portfolio.NewStore()
	botID := "bot-test-inactive-session"
	accountID := "acc-test"
	
	// Register bot and config
	setupBotConfigInDB(t, dbPool, botID, "momentum_trader", map[string]interface{}{
		"lookback_virtual_minutes": config.Distribution{Type: "fixed", Min: 15, Max: 15},
		"buy_trigger_pct":          config.Distribution{Type: "fixed", Min: 0.015, Max: 0.015},
		"sell_trigger_pct":         config.Distribution{Type: "fixed", Min: -0.015, Max: -0.015},
	})

	// Set human config to force inactive session probability to 1.0 (always inactive session)
	_, err := dbPool.Exec(ctx, `
		UPDATE bots 
		SET human_config = '{"inactive_session_probability": 1.0}'::jsonb
		WHERE external_bot_id = $1
	`, botID)
	if err != nil {
		t.Fatalf("failed to update human config: %v", err)
	}

	sched := scheduler.NewScheduler(1)
	engine := realism.New(12345)
	sessClock := &mockSessionClock{
		instance: &session.SessionInstance{
			InstanceID:          uuid.New(),
			VirtualDayIndex:     1,
			VirtualDurationSecs: 3600,
			RealDurationSecs:    360,
			Status:              session.StateContinuous,
		},
	}
	orderQ := queue.NewOrderQueue(1, 100)
	ruleStore := marketrules.NewStore()
	ruleStore.Update(setupMockRules())
	decLog := &mockDecisionRecorder{}
	seeder, _ := antipredict.NewSeeder([]byte("secret-seed-here"), "test-app")

	trader := NewTrader(
		dbPool, configMgr, portStore, sched, engine, sessClock, orderQ, ruleStore,
		func(id string) string { return accountID },
		func(id string) *uuid.UUID { idVal := uuid.New(); return &idVal },
		seeder, decLog, nil,
	)

	// Feed history to trigger a BUY signal
	now := time.Now()
	for i := 0; i < 20; i++ {
		trader.OnMarketEvent(mats.Event{
			Symbol:     "BBCA",
			Type:       "last_price",
			OccurredAt: now.Add(-time.Duration(20-i) * time.Minute),
			Payload:    json.RawMessage(`{"last":10000}`),
		})
	}
	trader.botBootTimes[botID] = now.Add(-10 * time.Hour)
	sched.Snapshots.Publish(scheduler.MarketSnapshot{
		Symbol: "BBCA", Price: 12000, LotSize: 100,
	})

	err = trader.HandleTask(ctx, botID, nil)
	if err != nil {
		t.Fatalf("HandleTask returned error: %v", err)
	}

	records := decLog.Records()
	var hasInactiveSessionHold bool
	for _, r := range records {
		if r.Action == decision.ActionHold && r.DecisionReason == "inactive_session" {
			hasInactiveSessionHold = true
		}
	}

	if !hasInactiveSessionHold {
		t.Errorf("expected hold due to inactive_session, got records: %+v", records)
	}
}

// ── Helpers for tests ──────────────────────────────────────────────────────────

func setupMockRules() *marketrules.SnapshotResolver {
	securitiesJSON := []byte(`[
		{"symbol":"BBCA","board":"RG","status":"listed","previous_close":10000,"last":10050}
	]`)
	rulesJSON := []byte(`[{
		"board":"RG",
		"lot_size_rules":[{"lot_size":100}],
		"tick_size_rules":[
			{"min_price":1,"max_price":200,"tick_size":1},
			{"min_price":200,"max_price":500,"tick_size":2},
			{"min_price":500,"max_price":2000,"tick_size":5},
			{"min_price":2000,"max_price":5000,"tick_size":10},
			{"min_price":5000,"max_price":9223372036854775807,"tick_size":25}
		],
		"price_band_rules":[{"ara_percent":0.35,"arb_percent":-0.35}]
	}]`)
	feeJSON := []byte(`{
		"brokerBuyRate":"0.0015","brokerSellRate":"0.0025",
		"settlementFeeRate":"0.0003","guaranteeFundRate":"0.0001",
		"vatRate":"0.11","sellTaxRate":"0.001"
	}`)
	r, _ := marketrules.NewSnapshotResolver(securitiesJSON, rulesJSON, feeJSON, time.Now())
	return r
}

func setupTestDBPool(t *testing.T) *pgxpool.Pool {
	databaseURL := os.Getenv("BOT_TEST_DATABASE_URL")
	if databaseURL == "" {
		databaseURL = os.Getenv("BOT_DATABASE_URL")
	}
	if databaseURL == "" {
		databaseURL = "postgres://postgres:postgres@localhost:5435/mandala_bot_test?sslmode=disable"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Skipf("skipping test; failed to connect to test db: %v", err)
	}
	// Try ping to confirm connection is actually live
	if err := pool.Ping(ctx); err != nil {
		t.Skipf("skipping test; failed to ping test db: %v", err)
	}
	return pool
}

func setupBotConfigInDB(t *testing.T, pool *pgxpool.Pool, botID, strategyType string, params map[string]interface{}) {
	ctx := context.Background()
	paramsJSON, err := json.Marshal(params)
	if err != nil {
		t.Fatalf("failed to marshal params: %v", err)
	}
	// We need to insert bot with a valid internal UUID first if not present
	internalID := uuid.New()
	_, err = pool.Exec(ctx, `
		INSERT INTO bots (internal_id, external_bot_id, strategy_type, risk_config, human_config, activity_config, parameters, created_at, updated_at)
		VALUES ($1, $2, $3, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $4, NOW(), NOW())
		ON CONFLICT (external_bot_id) DO UPDATE
		SET strategy_type = EXCLUDED.strategy_type, parameters = EXCLUDED.parameters
	`, internalID, botID, strategyType, paramsJSON)
	if err != nil {
		t.Fatalf("failed to insert bot config: %v", err)
	}
}
