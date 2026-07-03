package momentum

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/rand"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Mandala-Exchange/BOT/internal/antipredict"
	"github.com/Mandala-Exchange/BOT/internal/client/mats"
	"github.com/Mandala-Exchange/BOT/internal/config"
	"github.com/Mandala-Exchange/BOT/internal/decision"
	"github.com/Mandala-Exchange/BOT/internal/logger"
	"github.com/Mandala-Exchange/BOT/internal/marketrules"
	"github.com/Mandala-Exchange/BOT/internal/portfolio"
	"github.com/Mandala-Exchange/BOT/internal/queue"
	"github.com/Mandala-Exchange/BOT/internal/realism"
	"github.com/Mandala-Exchange/BOT/internal/scheduler"
	"github.com/Mandala-Exchange/BOT/internal/sentiment"
	"github.com/Mandala-Exchange/BOT/internal/session"
)

// DecisionRecorder is the subset of *decision.Pipeline used by Trader.
type DecisionRecorder interface {
	Record(ctx context.Context, entry decision.DecisionLog) error
}

// AccountLookup defines how the strategy looks up the sekuritas account ID for a bot.
type AccountLookup func(botID string) string

// InternalIDLookup returns the internal UUID of a bot by its external bot ID.
type InternalIDLookup func(botID string) *uuid.UUID

type PricePoint struct {
	Price      int64
	Volume     int64
	OccurredAt time.Time
}

// Trader implements the Momentum Trader autonomous strategy.
// Per PRD §4.3 & BOT_STRATEGY_SPEC.md §8: Beli jika harga naik, jual jika harga turun.
// Ia melacak window history harga berdasarkan virtual time dari MATS WS public events.
// Dilengkapi dengan persistence/checkpoint lewat replay, volume confirmation, hysteresis,
// sentiment/inventory bias, dan stop-loss/take-profit exit.
type Trader struct {
	dbPool       *pgxpool.Pool
	configMgr    *config.ConfigManager
	portStore    *portfolio.Store
	sched        *scheduler.Scheduler
	engine       *realism.Engine
	clock        realism.SessionClock
	orderQ       *queue.OrderQueue
	ruleStore    *marketrules.Store
	lookup       AccountLookup
	idLookup     InternalIDLookup
	seeder       *antipredict.Seeder
	decisionPipe DecisionRecorder
	sentimentSvc *sentiment.Service

	rngMu                sync.Mutex
	botRNGs              map[string]*rand.Rand
	botRNGLocks          map[string]*sync.Mutex
	botSessions          map[string]uuid.UUID
	cancelScheduled      map[string]struct{}
	cancelEvaluated      map[string]struct{}
	cooldownsInitialized map[string]bool

	historyMu    sync.RWMutex
	history      map[string][]PricePoint // symbol -> points
	botBootTimes map[string]time.Time    // botID -> bootTime
	cooldowns    map[string]map[string]time.Time // botID -> symbol -> cooldownUntil
}

func NewTrader(
	dbPool *pgxpool.Pool,
	configMgr *config.ConfigManager,
	portStore *portfolio.Store,
	sched *scheduler.Scheduler,
	engine *realism.Engine,
	clock realism.SessionClock,
	orderQ *queue.OrderQueue,
	ruleStore *marketrules.Store,
	lookup AccountLookup,
	idLookup InternalIDLookup,
	seeder *antipredict.Seeder,
	decisionPipe DecisionRecorder,
	sentimentSvc *sentiment.Service,
) *Trader {
	return &Trader{
		dbPool:               dbPool,
		configMgr:            configMgr,
		portStore:            portStore,
		sched:                sched,
		engine:               engine,
		clock:                clock,
		orderQ:               orderQ,
		ruleStore:            ruleStore,
		lookup:               lookup,
		idLookup:             idLookup,
		seeder:               seeder,
		decisionPipe:         decisionPipe,
		sentimentSvc:         sentimentSvc,
		botRNGs:              make(map[string]*rand.Rand),
		botRNGLocks:          make(map[string]*sync.Mutex),
		botSessions:          make(map[string]uuid.UUID),
		cancelScheduled:      make(map[string]struct{}),
		cancelEvaluated:      make(map[string]struct{}),
		cooldownsInitialized: make(map[string]bool),
		history:              make(map[string][]PricePoint),
		botBootTimes:         make(map[string]time.Time),
		cooldowns:            make(map[string]map[string]time.Time),
	}
}

// OnMarketEvent receives trade and price update events from the market WebSocket stream.
// It records points in the memory window history for lookback calculations.
func (t *Trader) OnMarketEvent(event mats.Event) {
	if event.Symbol == "" {
		return
	}
	if event.Type != "last_price" && event.Type != "trade_tape" {
		return
	}

	var price int64
	var volume int64

	var payload map[string]interface{}
	if err := json.Unmarshal(event.Payload, &payload); err != nil {
		return
	}

	if event.Type == "last_price" {
		if val, exists := payload["last"]; exists {
			price, _ = strconv.ParseInt(fmt.Sprint(val), 10, 64)
		}
	} else if event.Type == "trade_tape" {
		if val, exists := payload["price"]; exists {
			price, _ = strconv.ParseInt(fmt.Sprint(val), 10, 64)
		}
		if val, exists := payload["quantity"]; exists {
			volume, _ = strconv.ParseInt(fmt.Sprint(val), 10, 64)
		}
	}

	if price <= 0 {
		return
	}

	occurredAt := event.OccurredAt
	if occurredAt.IsZero() {
		occurredAt = time.Now().UTC()
	}

	t.historyMu.Lock()
	defer t.historyMu.Unlock()

	symbol := strings.ToUpper(event.Symbol)
	t.history[symbol] = append(t.history[symbol], PricePoint{
		Price:      price,
		Volume:     volume,
		OccurredAt: occurredAt,
	})

	// Prevent memory growth: retain up to latest 1000 points.
	if len(t.history[symbol]) > 1000 {
		t.history[symbol] = t.history[symbol][len(t.history[symbol])-1000:]
	}
}

// HandleTask processes a scheduled tick for the momentum trader.
func (t *Trader) HandleTask(ctx context.Context, botID string, payload interface{}) error {
	botConfig, _, err := t.configMgr.GetDBConfig(ctx, botID)
	if err != nil {
		return fmt.Errorf("failed to load bot config: %w", err)
	}

	if botConfig.StrategyType != "momentum_trader" {
		return fmt.Errorf("invalid strategy type for bot %s: %s", botID, botConfig.StrategyType)
	}

	if botConfig.Status == "disabled" || botConfig.Status == "bankrupt" {
		return nil // Stop trading and do NOT reschedule next tick
	}

	mCfg, err := ParseConfig(botConfig.Parameters)
	if err != nil {
		return fmt.Errorf("invalid momentum config: %w", err)
	}
	t.scheduleRecoveredCancels(botID, mCfg)

	rules := t.ruleStore.Get()
	if rules == nil {
		return fmt.Errorf("market rules unavailable")
	}

	instance := t.clock.GetInstance()
	var sessionID uuid.UUID
	if instance != nil {
		sessionID = instance.InstanceID
	}

	t.rngMu.Lock()
	botRNGLock := t.botRNGLocks[botID]
	if botRNGLock == nil {
		botRNGLock = &sync.Mutex{}
		t.botRNGLocks[botID] = botRNGLock
	}
	t.rngMu.Unlock()
	botRNGLock.Lock()
	defer botRNGLock.Unlock()

	t.rngMu.Lock()
	rng, exists := t.botRNGs[botID]
	lastSession := t.botSessions[botID]
	if !exists || lastSession != sessionID {
		var seed int64
		if instance != nil && instance.InstanceID != uuid.Nil && t.seeder != nil {
			seedVal, seedErr := t.seeder.SessionSeed(botID, instance.InstanceID, botConfig.ConfigVersion)
			if seedErr != nil {
				seed = time.Now().UnixNano()
			} else {
				seed = seedVal
			}
		} else {
			seed = time.Now().UnixNano()
		}
		rng = rand.New(rand.NewSource(seed))
		t.botRNGs[botID] = rng
		t.botSessions[botID] = sessionID
		// Clear local state on session rollover
		t.cooldowns[botID] = make(map[string]time.Time)
	}
	if t.cooldowns[botID] == nil {
		t.cooldowns[botID] = make(map[string]time.Time)
	}
	cooldownsInit := t.cooldownsInitialized[botID]
	t.rngMu.Unlock()

	if !cooldownsInit {
		internalID := t.idLookup(botID)
		if err := t.recoverCooldownsFromDB(ctx, botID, internalID, mCfg); err != nil {
			logger.Error("Failed to recover cooldowns from DB", map[string]interface{}{"bot_id": botID, "error": err.Error()})
		}
	}

	defer t.scheduleNextTick(botID, mCfg, rng)

	sessionStatus := "unknown"
	sessionInstanceID := (*uuid.UUID)(nil)
	virtualDayIndex := (*int64)(nil)
	if instance != nil {
		sessionStatus = string(instance.Status)
		id := instance.InstanceID
		sessionInstanceID = &id
		day := int64(instance.VirtualDayIndex)
		virtualDayIndex = &day
	}
	internalID := t.idLookup(botID)

	recordDecision := func(action decision.LogAction, reason string, snapshot map[string]interface{}) {
		entry := decision.DecisionLog{
			InternalID:        internalID,
			SessionInstanceID: sessionInstanceID,
			VirtualDayIndex:   virtualDayIndex,
			Strategy:          "momentum_trader",
			SessionStatus:     sessionStatus,
			Action:            action,
			DecisionReason:    reason,
			ContextSnapshot:   snapshot,
			CreatedAt:         time.Now().UTC(),
		}
		if recErr := t.decisionPipe.Record(ctx, entry); recErr != nil {
			_ = recErr
		}
	}

	symbol, err := t.selectSymbol(mCfg.SymbolsUniverse, rules, rng)
	if err != nil {
		recordDecision(decision.ActionReject, "symbol_selection_failed", map[string]interface{}{
			"bot_id": botID, "error": err.Error(),
		})
		return err
	}

	priceLatest, ok := t.sched.Snapshots.LastPriceIDR(symbol)
	if !ok || priceLatest <= 0 {
		recordDecision(decision.ActionHold, "market_price_unavailable", map[string]interface{}{
			"bot_id": botID, "symbol": symbol,
		})
		return nil
	}

	// ── Task 4.3.4: Position Exit Check (Take Profit & Stop Loss)
	accountID := t.lookup(botID)
	if accountID != "" {
		if acc, ok := t.portStore.Account(accountID); ok {
			for _, pos := range acc.Positions {
				if pos.Symbol == symbol && pos.AvailableShares > 0 {
					entryPrice := pos.WeightedAveragePrice()
					if entryPrice > 0 {
						plPct := float64(priceLatest-entryPrice) / float64(entryPrice)
						isTP := plPct >= mCfg.TakeProfitPct
						isSL := plPct <= -mCfg.StopLossPct
						if isTP || isSL {
							reason := "take_profit"
							if isSL {
								reason = "stop_loss"
							}
							
							// Trigger Exit Order
							lotSize, _ := rules.LotSize(symbol)
							if lotSize <= 0 {
								lotSize = 100
							}
							quantityShares := (pos.AvailableShares / lotSize) * lotSize
							if quantityShares > 0 {
								intent := realism.OrderIntent{
									BotID:          botID,
									Symbol:         symbol,
									Side:           "sell",
									PriceIDR:       priceLatest,
									QuantityShares: quantityShares,
								}
								plan, planErr := t.engine.PlanDecision(t.clock, rules, botConfig.Human, botConfig.Activity, intent)
								if planErr == nil && !plan.Abort && !plan.InactiveSession {
									clientOrderID := fmt.Sprintf("bot:%s:%s:exit:%d", botID, symbol, rng.Uint64())
									
									recordDecision(decision.ActionPlaceOrder, "position_exit_trigger", map[string]interface{}{
										"bot_id":          botID,
										"symbol":          symbol,
										"side":            "sell",
										"price_idr":       plan.Order.PriceIDR,
										"quantity_shares": plan.Order.QuantityShares,
										"exit_reason":     reason,
										"pl_pct":          plPct,
										"client_order_id": clientOrderID,
									})

									t.sched.Schedule(&scheduler.Task{
										BotID:     botID,
										ExecuteAt: time.Now().Add(plan.ReactionDelay),
										Payload: delayedSubmitPayload{
											BotID:             botID,
											AccountID:         accountID,
											Symbol:            symbol,
											Side:              "sell",
											PriceIDR:          plan.Order.PriceIDR,
											QuantityShares:    plan.Order.QuantityShares,
											ClientOrderID:     clientOrderID,
											SessionInstanceID: sessionInstanceID,
											VirtualDayIndex:   virtualDayIndex,
											SessionStatus:     sessionStatus,
											InternalID:        internalID,
										},
										Handler: t.handleDelayedSubmit,
									})
									return nil
								}
							}
						}
					}
				}
			}
		}
	}

	// ── Cooldown Check
	t.rngMu.Lock()
	if t.cooldowns[botID] == nil {
		t.cooldowns[botID] = make(map[string]time.Time)
	}
	cooldownUntil, onCooldown := t.cooldowns[botID][symbol]
	t.rngMu.Unlock()
	if onCooldown && time.Now().Before(cooldownUntil) {
		recordDecision(decision.ActionHold, "cooldown_active", map[string]interface{}{
			"bot_id": botID, "symbol": symbol, "cooldown_until": cooldownUntil.UTC(),
		})
		return nil
	}

	// ── Task 4.3.1 & 4.3.2: Lookback & History check (Warm-up check)
	t.rngMu.Lock()
	bootTime, hasBoot := t.botBootTimes[botID]
	if !hasBoot {
		bootTime = time.Now()
		t.botBootTimes[botID] = bootTime
	}
	t.rngMu.Unlock()

	lookbackMin := sampleDistribution(mCfg.LookbackVirtualMinutes, rng)
	lookbackRealDuration := t.clock.VirtualToRealDelay(time.Duration(lookbackMin * float64(time.Minute)))

	if time.Since(bootTime) < lookbackRealDuration {
		recordDecision(decision.ActionHold, "warm_up_insufficient_history", map[string]interface{}{
			"elapsed_seconds":  time.Since(bootTime).Seconds(),
			"required_seconds": lookbackRealDuration.Seconds(),
		})
		return nil
	}

	t.historyMu.RLock()
	pts := t.history[strings.ToUpper(symbol)]
	t.historyMu.RUnlock()

	now := time.Now()
	var window []PricePoint
	for _, p := range pts {
		if p.OccurredAt.After(now) {
			continue // No-lookahead: refuse future events
		}
		if p.OccurredAt.After(now.Add(-lookbackRealDuration)) {
			window = append(window, p)
		}
	}

	if len(window) < mCfg.Confirmation.MinimumTradeCount {
		recordDecision(decision.ActionHold, "insufficient_trade_count", map[string]interface{}{
			"bot_id": botID, "symbol": symbol, "count": len(window), "required": mCfg.Confirmation.MinimumTradeCount,
		})
		return nil
	}

	// Evaluate Trend Signal
	priceLatestPoint := window[len(window)-1].Price
	priceStartPoint := window[0].Price
	priceMovePct := float64(priceLatestPoint-priceStartPoint) / float64(priceStartPoint)

	// Persistence calculation
	persistenceReal := t.clock.VirtualToRealDelay(time.Duration(mCfg.Confirmation.MinimumPersistenceVirtualSeconds) * time.Second)
	persistCutoff := now.Add(-persistenceReal)
	var pricePersist int64 = priceStartPoint
	for i := len(window) - 1; i >= 0; i-- {
		if window[i].OccurredAt.Before(persistCutoff) || window[i].OccurredAt.Equal(persistCutoff) {
			pricePersist = window[i].Price
			break
		}
	}
	persistMovePct := float64(priceLatestPoint-pricePersist) / float64(pricePersist)

	buyTrigger := sampleDistribution(mCfg.BuyTriggerPct, rng)
	sellTrigger := sampleDistribution(mCfg.SellTriggerPct, rng)

	isBuySignal := priceMovePct >= buyTrigger && persistMovePct >= (buyTrigger-mCfg.EntryHysteresisPct)
	isSellSignal := priceMovePct <= sellTrigger && persistMovePct <= (sellTrigger+mCfg.EntryHysteresisPct)

	if !isBuySignal && !isSellSignal {
		recordDecision(decision.ActionHold, "no_trend_detected", map[string]interface{}{
			"price_move_pct": priceMovePct,
			"buy_trigger":    buyTrigger,
			"sell_trigger":   sellTrigger,
		})
		return nil
	}

	// Volume Confirmation check
	if rng.Float64() >= mCfg.Confirmation.RequireVolumeSignalProbability {
		recordDecision(decision.ActionHold, "volume_confirmation_failed", map[string]interface{}{
			"price_move_pct": priceMovePct,
		})
		return nil
	}

	// Decide side based on signal
	side := "buy"
	if isSellSignal {
		side = "sell"
	}

	// Sentiment & Inventory bias (Task 4.3.2/4.3.4)
	execProb := 0.80
	if t.sentimentSvc != nil {
		if sState, sErr := t.sentimentSvc.Current(time.Now()); sErr == nil {
			switch sState.Overall {
			case sentiment.Bullish:
				if side == "buy" {
					execProb += 0.15
				} else {
					execProb -= 0.20
				}
			case sentiment.Bearish:
				if side == "buy" {
					execProb -= 0.30
				} else {
					execProb += 0.15
				}
			}

			// Sector sentiment check is skipped in Fase 4 because sector metadata is not yet encoded in SnapshotResolver.
			// This will be enabled in Fase 5 when sector metadata is added.
			_ = rules
		}
	}

	// Inventory bias
	availShares := t.getAvailableShares(botID, symbol)
	if side == "buy" && availShares > 0 {
		execProb *= 0.8
	}

	if rng.Float64() >= execProb {
		recordDecision(decision.ActionHold, "bias_probability_skipped", map[string]interface{}{
			"side":      side,
			"exec_prob": execProb,
		})
		return nil
	}

	// Lot Size & Risk Clamping
	lotSize, ok := rules.LotSize(symbol)
	if !ok || lotSize <= 0 {
		recordDecision(decision.ActionReject, "lot_size_missing", map[string]interface{}{
			"symbol": symbol,
		})
		return fmt.Errorf("lot size not found for symbol %s", symbol)
	}

	quantityLots := sampleDistribution(mCfg.OrderSizeLots, rng)
	quantityShares := int64(quantityLots) * lotSize
	if quantityShares <= 0 {
		recordDecision(decision.ActionHold, "quantity_zero_skip", nil)
		return nil
	}

	if quantityLots > float64(botConfig.Risk.MaxOrderSizeLots) {
		quantityShares = int64(botConfig.Risk.MaxOrderSizeLots) * lotSize
	}

	// Exit Criteria & Precedence (No pending proceeds buy check, Sell inventory limit)
	if side == "sell" {
		if quantityShares > availShares {
			quantityShares = (availShares / lotSize) * lotSize
		}
		if quantityShares <= 0 {
			recordDecision(decision.ActionHold, "insufficient_inventory", map[string]interface{}{
				"symbol": symbol,
			})
			return nil
		}
	} else if side == "buy" {
		// Cash limit check (exclude pending proceeds)
		acc, hasAcc := t.portStore.Account(accountID)
		if !hasAcc {
			return nil
		}
		maxBuyQty := acc.Cash.AvailableIDR / priceLatest
		if quantityShares > maxBuyQty {
			quantityShares = (maxBuyQty / lotSize) * lotSize
		}
		if quantityShares <= 0 {
			recordDecision(decision.ActionHold, "insufficient_cash", map[string]interface{}{
				"available_cash": acc.Cash.AvailableIDR,
				"price":          priceLatest,
			})
			return nil
		}
	}

	// Filter through Realism Engine
	intent := realism.OrderIntent{
		BotID:          botID,
		Symbol:         symbol,
		Side:           side,
		PriceIDR:       priceLatest,
		QuantityShares: quantityShares,
	}

	plan, planErr := t.engine.PlanDecision(t.clock, rules, botConfig.Human, botConfig.Activity, intent)
	if planErr != nil {
		if errors.Is(planErr, realism.ErrInactiveSegment) {
			recordDecision(decision.ActionHold, "inactive_segment", nil)
			return nil
		}
		recordDecision(decision.ActionReject, "realism_plan_failed", map[string]interface{}{
			"error": planErr.Error(),
		})
		return fmt.Errorf("realism plan error: %w", planErr)
	}

	if plan.InactiveSession {
		recordDecision(decision.ActionHold, "inactive_session", nil)
		return nil
	}

	if plan.Abort {
		recordDecision(decision.ActionHold, "decision_abort", nil)
		return nil
	}

	clientOrderID := fmt.Sprintf("bot:%s:%s:%d", botID, sessionID.String(), rng.Uint64())
	recordDecision(decision.ActionPlaceOrder, "momentum_trader_place", map[string]interface{}{
		"bot_id":          botID,
		"symbol":          symbol,
		"side":            side,
		"price_idr":       plan.Order.PriceIDR,
		"quantity_shares": plan.Order.QuantityShares,
		"client_order_id": clientOrderID,
	})

	t.sched.Schedule(&scheduler.Task{
		BotID:     botID,
		ExecuteAt: time.Now().Add(plan.ReactionDelay),
		Payload: delayedSubmitPayload{
			BotID:             botID,
			AccountID:         accountID,
			Symbol:            symbol,
			Side:              side,
			PriceIDR:          plan.Order.PriceIDR,
			QuantityShares:    plan.Order.QuantityShares,
			ClientOrderID:     clientOrderID,
			SessionInstanceID: sessionInstanceID,
			VirtualDayIndex:   virtualDayIndex,
			SessionStatus:     sessionStatus,
			InternalID:        internalID,
		},
		Handler: t.handleDelayedSubmit,
	})

	// Enter Cooldown for this symbol (Task 4.3.3)
	cooldownMin := sampleDistribution(mCfg.CooldownVirtualMinutes, rng)
	cooldownReal := t.clock.VirtualToRealDelay(time.Duration(cooldownMin * float64(time.Minute)))
	t.rngMu.Lock()
	t.cooldowns[botID][symbol] = time.Now().Add(cooldownReal)
	t.rngMu.Unlock()

	return nil
}

type delayedSubmitPayload struct {
	BotID             string
	AccountID         string
	Symbol            string
	Side              string
	PriceIDR          int64
	QuantityShares    int64
	ClientOrderID     string
	SessionInstanceID *uuid.UUID
	VirtualDayIndex   *int64
	SessionStatus     string
	InternalID        *uuid.UUID
}

func (t *Trader) handleDelayedSubmit(ctx context.Context, botID string, payload interface{}) error {
	p, ok := payload.(delayedSubmitPayload)
	if !ok {
		return fmt.Errorf("invalid payload for delayed submit")
	}

	if p.AccountID == "" {
		return fmt.Errorf("missing Sekuritas account mapping for bot %s", botID)
	}

	req := &queue.OrderRequest{
		ClientOrderID: p.ClientOrderID,
		BotID:         p.BotID,
		Priority:      queue.PriorityNormal,
		Payload: queue.SubmitOrderPayload{
			AccountID: p.AccountID,
			Symbol:    p.Symbol,
			Side:      p.Side,
			PriceIDR:  p.PriceIDR,
			Quantity:  p.QuantityShares,
		},
		ExpiresAt: time.Now().Add(15 * time.Second),
	}

	trackErr := t.portStore.TrackLocalOrder(&portfolio.LocalOrder{
		ClientOrderID: p.ClientOrderID, AccountID: p.AccountID, Symbol: p.Symbol,
		Side: p.Side, OrderType: "limit", PriceIDR: p.PriceIDR,
		OriginalQtyShares: p.QuantityShares, Status: portfolio.StatusQueued,
	})
	if trackErr != nil && !errors.Is(trackErr, portfolio.ErrOrderAlreadyTracked) {
		return trackErr
	}

	if submitErr := t.orderQ.Submit(req); submitErr != nil {
		_ = t.portStore.UpdateLocalOrderStatus(p.ClientOrderID, portfolio.StatusExpiredBeforeSubmit)
		rejectReason := submitErr.Error()
		rejectEntry := decision.DecisionLog{
			InternalID:        p.InternalID,
			SessionInstanceID: p.SessionInstanceID,
			VirtualDayIndex:   p.VirtualDayIndex,
			Strategy:          "momentum_trader",
			Symbol:            p.Symbol,
			SessionStatus:     p.SessionStatus,
			Action:            decision.ActionReject,
			DecisionReason:    "queue_submit_failed",
			ClientOrderID:     &p.ClientOrderID,
			RejectReason:      &rejectReason,
			ContextSnapshot:   map[string]interface{}{"bot_id": p.BotID},
			CreatedAt:         time.Now().UTC(),
		}
		_ = t.decisionPipe.Record(context.Background(), rejectEntry)
		return nil
	}

	return nil
}

func (t *Trader) scheduleRecoveredCancels(botID string, cfg Config) {
	accountID := t.lookup(botID)
	if accountID == "" {
		return
	}
	for _, order := range t.portStore.OpenLocalOrders(accountID) {
		if order.Status != portfolio.StatusOpen && order.Status != portfolio.StatusPartiallyFilled && order.Status != portfolio.StatusSubmitUnknown {
			continue
		}
		t.scheduleCancel(botID, accountID, order, cfg)
	}
}

func (t *Trader) scheduleCancel(botID, accountID string, order portfolio.LocalOrder, cfg Config) {
	openedAt := order.OpenedAt
	if openedAt.IsZero() {
		if order.Status == portfolio.StatusSubmitUnknown {
			openedAt = time.Now().Add(-15 * time.Second)
		} else {
			return
		}
	}
	t.rngMu.Lock()
	if _, evaluated := t.cancelEvaluated[order.ClientOrderID]; evaluated {
		t.rngMu.Unlock()
		return
	}
	if _, exists := t.cancelScheduled[order.ClientOrderID]; exists {
		t.rngMu.Unlock()
		return
	}
	t.cancelScheduled[order.ClientOrderID] = struct{}{}
	t.rngMu.Unlock()

	rng := orderRNG(order.ClientOrderID + ":age")
	// Momentum trader can cancel aged normal orders to re-evaluate (cooldown)
	virtualAge := time.Duration(sampleDistribution(cfg.CooldownVirtualMinutes, rng) * float64(time.Minute))
	due := openedAt.Add(t.clock.VirtualToRealDelay(virtualAge))
	if due.Before(time.Now()) {
		due = time.Now()
	}
	t.sched.Schedule(&scheduler.Task{
		BotID: botID, ExecuteAt: due,
		Payload: delayedCancelPayload{
			BotID: botID, AccountID: accountID, ClientOrderID: order.ClientOrderID,
			Symbol: order.Symbol, Config: cfg,
		},
		Handler: t.handleDelayedCancel,
	})
}

type delayedCancelPayload struct {
	BotID             string
	AccountID         string
	ClientOrderID     string
	InternalID        *uuid.UUID
	SessionInstanceID *uuid.UUID
	VirtualDayIndex   *int64
	SessionStatus     string
	Symbol            string
	Config            Config
}

func (t *Trader) handleDelayedCancel(ctx context.Context, botID string, payload interface{}) error {
	p, ok := payload.(delayedCancelPayload)
	if !ok {
		return fmt.Errorf("invalid payload for delayed cancel")
	}
	defer t.clearCancelScheduled(p.ClientOrderID)

	order, exists := t.portStore.GetLocalOrder(p.ClientOrderID)
	if !exists {
		return t.recordCancelHold(ctx, p, "cancel_order_not_tracked")
	}
	if order.Status.IsTerminal() {
		return t.recordCancelHold(ctx, p, "cancel_order_already_terminal")
	}
	if order.Status != portfolio.StatusOpen && order.Status != portfolio.StatusPartiallyFilled && order.Status != portfolio.StatusSubmitUnknown {
		return t.recordCancelHold(ctx, p, "cancel_order_not_authoritatively_open")
	}
	if order.RemainingQtyShares() <= 0 {
		return t.recordCancelHold(ctx, p, "cancel_order_no_remaining_quantity")
	}
	instance := t.clock.GetInstance()
	if instance == nil || instance.Status == session.StateNonCancellation {
		return t.recordCancelHold(ctx, p, "cancel_deferred_by_market_rule")
	}

	t.markCancelEvaluated(p.ClientOrderID)

	req := &queue.OrderRequest{
		ClientOrderID: p.ClientOrderID + ":cancel:1",
		BotID:         p.BotID,
		Priority:      queue.PriorityRiskCancel,
		Payload: queue.CancelOrderPayload{
			AccountID:     p.AccountID,
			ClientOrderID: p.ClientOrderID,
		},
		ExpiresAt: time.Now().Add(10 * time.Second),
	}

	if submitErr := t.orderQ.Submit(req); submitErr != nil {
		t.clearCancelEvaluated(p.ClientOrderID)
		rejectReason := submitErr.Error()
		rejectEntry := decision.DecisionLog{
			InternalID:        p.InternalID,
			SessionInstanceID: p.SessionInstanceID,
			VirtualDayIndex:   p.VirtualDayIndex,
			Strategy:          "momentum_trader",
			Symbol:            p.Symbol,
			SessionStatus:     p.SessionStatus,
			Action:            decision.ActionReject,
			DecisionReason:    "queue_cancel_submit_failed",
			ClientOrderID:     &p.ClientOrderID,
			RejectReason:      &rejectReason,
			ContextSnapshot:   map[string]interface{}{"bot_id": p.BotID},
			CreatedAt:         time.Now().UTC(),
		}
		_ = t.decisionPipe.Record(context.Background(), rejectEntry)
	}

	return nil
}

func (t *Trader) recordCancelHold(ctx context.Context, p delayedCancelPayload, reason string) error {
	entry := decision.DecisionLog{
		InternalID: p.InternalID, SessionInstanceID: p.SessionInstanceID,
		VirtualDayIndex: p.VirtualDayIndex, Strategy: "momentum_trader",
		Symbol: p.Symbol, SessionStatus: p.SessionStatus, Action: decision.ActionHold,
		DecisionReason: reason, ClientOrderID: &p.ClientOrderID,
		ContextSnapshot: map[string]interface{}{"bot_id": p.BotID},
		CreatedAt:       time.Now().UTC(),
	}
	return t.decisionPipe.Record(ctx, entry)
}

func (t *Trader) markCancelEvaluated(clientOrderID string) {
	t.rngMu.Lock()
	if t.cancelEvaluated == nil {
		t.cancelEvaluated = make(map[string]struct{})
	}
	t.cancelEvaluated[clientOrderID] = struct{}{}
	t.rngMu.Unlock()
}

func (t *Trader) clearCancelEvaluated(clientOrderID string) {
	t.rngMu.Lock()
	delete(t.cancelEvaluated, clientOrderID)
	t.rngMu.Unlock()
}

func (t *Trader) clearCancelScheduled(clientOrderID string) {
	t.rngMu.Lock()
	delete(t.cancelScheduled, clientOrderID)
	t.rngMu.Unlock()
}

func orderRNG(key string) *rand.Rand {
	sum := sha256.Sum256([]byte(key))
	return rand.New(rand.NewSource(int64(binary.BigEndian.Uint64(sum[:8]))))
}

func (t *Trader) scheduleNextTick(botID string, cfg Config, rng *rand.Rand) {
	intervalMin := sampleDistribution(cfg.DecisionIntervalVirtualMinutes, rng)
	delay := t.clock.VirtualToRealDelay(time.Duration(intervalMin * float64(time.Minute)))
	if delay < time.Second {
		delay = time.Second
	}

	task := &scheduler.Task{
		BotID:     botID,
		ExecuteAt: time.Now().Add(delay),
		Handler:   t.HandleTask,
	}
	t.sched.Schedule(task)
}

func (t *Trader) selectSymbol(cfg SymbolsUniverseConfig, rules *marketrules.SnapshotResolver, rng *rand.Rand) (string, error) {
	switch cfg.Type {
	case "fixed":
		if len(cfg.Symbols) == 0 {
			return "", fmt.Errorf("symbols_universe type 'fixed' has empty symbols list")
		}
		return cfg.Symbols[rng.Intn(len(cfg.Symbols))], nil

	case "random_n":
		allSymbols := rules.ListedSymbols()
		if len(allSymbols) == 0 {
			return "", fmt.Errorf("no listed symbols available in current rule snapshot")
		}
		n := 1
		if cfg.Count != nil && *cfg.Count > 0 {
			n = *cfg.Count
		}
		if n > len(allSymbols) {
			n = len(allSymbols)
		}
		sampled := make([]string, len(allSymbols))
		copy(sampled, allSymbols)
		rng.Shuffle(len(sampled), func(i, j int) { sampled[i], sampled[j] = sampled[j], sampled[i] })
		return sampled[rng.Intn(n)], nil

	default:
		allSymbols := rules.ListedSymbols()
		if len(allSymbols) == 0 {
			return "", fmt.Errorf("no listed symbols available in current rule snapshot")
		}
		return allSymbols[rng.Intn(len(allSymbols))], nil
	}
}

func (t *Trader) getAvailableShares(botID, symbol string) int64 {
	accountID := t.lookup(botID)
	if accountID == "" {
		return 0
	}
	acc, ok := t.portStore.Account(accountID)
	if !ok {
		return 0
	}
	for _, pos := range acc.Positions {
		if pos.Symbol == symbol {
			return pos.AvailableShares
		}
	}
	return 0
}

func sampleDistribution(d config.Distribution, rng *rand.Rand) float64 {
	switch d.Type {
	case "fixed":
		return d.Min
	case "uniform":
		return d.Min + rng.Float64()*(d.Max-d.Min)
	case "normal":
		val := rng.NormFloat64()*d.StdDev + d.Mean
		return clamp(val, d.Min, d.Max)
	case "lognormal":
		val := math.Exp(rng.NormFloat64()*d.StdDev + d.Mean)
		return clamp(val, d.Min, d.Max)
	default:
		return d.Min
	}
}

func clamp(value, min, max float64) float64 {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

func (t *Trader) recoverCooldownsFromDB(ctx context.Context, botID string, internalID *uuid.UUID, cfg Config) error {
	if internalID == nil || t.dbPool == nil {
		t.rngMu.Lock()
		t.cooldownsInitialized[botID] = true
		t.rngMu.Unlock()
		return nil
	}

	rows, err := t.dbPool.Query(ctx, `
		SELECT symbol, created_at, context_snapshot
		FROM bot_decision_logs
		WHERE internal_id = $1 AND strategy = 'momentum_trader' AND action = 'place_order'
		ORDER BY created_at DESC
		LIMIT 100
	`, *internalID)
	if err != nil {
		return err
	}
	defer rows.Close()

	t.rngMu.Lock()
	defer t.rngMu.Unlock()

	for rows.Next() {
		var symbol string
		var createdAt time.Time
		var contextSnapshot []byte
		if err := rows.Scan(&symbol, &createdAt, &contextSnapshot); err != nil {
			continue
		}

		symbol = strings.ToUpper(symbol)
		if _, exists := t.cooldowns[botID][symbol]; exists {
			continue
		}

		cooldownMaxMin := cfg.CooldownVirtualMinutes.Max
		cooldownRealDuration := t.clock.VirtualToRealDelay(time.Duration(cooldownMaxMin * float64(time.Minute)))
		cooldownUntil := createdAt.Add(cooldownRealDuration)

		if time.Now().Before(cooldownUntil) {
			t.cooldowns[botID][symbol] = cooldownUntil
		}
	}

	t.cooldownsInitialized[botID] = true
	return nil
}
