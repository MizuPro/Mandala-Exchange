package noise

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"math/rand"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/Mandala-Exchange/BOT/internal/antipredict"
	"github.com/Mandala-Exchange/BOT/internal/config"
	"github.com/Mandala-Exchange/BOT/internal/decision"
	"github.com/Mandala-Exchange/BOT/internal/marketrules"
	"github.com/Mandala-Exchange/BOT/internal/portfolio"
	"github.com/Mandala-Exchange/BOT/internal/queue"
	"github.com/Mandala-Exchange/BOT/internal/realism"
	"github.com/Mandala-Exchange/BOT/internal/scheduler"
	"github.com/Mandala-Exchange/BOT/internal/session"
)

// DecisionRecorder is the subset of *decision.Pipeline used by Trader.
// Defining it as an interface here allows unit tests to inject a no-op
// recorder without needing a live PostgreSQL connection.
type DecisionRecorder interface {
	Record(ctx context.Context, entry decision.DecisionLog) error
}

// AccountLookup defines how the strategy looks up the sekuritas account ID for a bot.
type AccountLookup func(botID string) string

// InternalIDLookup returns the internal UUID of a bot by its external bot ID.
// Used to populate decision log InternalID field.
type InternalIDLookup func(botID string) *uuid.UUID

// Trader implements the Noise Trader autonomous strategy.
// Per PRD §7, it selects random symbols, sides, prices within a deviation, and quantities.
// It also has an inventory-awareness bias for side selection.
//
// Contract:
//   - All orders are enqueued through orderQ (never direct to MATS).
//   - rng seed is deterministic per-bot per-session via HMAC (BOT_STRATEGY_SPEC.md §5).
//   - Every decision (place, abort, cancel, reject) is recorded in the decision pipeline.
//   - Price is snapped to valid tick then clamped to ARA/ARB via realism.PlanDecision → Resolve.
type Trader struct {
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

	rngMu           sync.Mutex
	botRNGs         map[string]*rand.Rand
	botRNGLocks     map[string]*sync.Mutex
	botSessions     map[string]uuid.UUID
	cancelScheduled map[string]struct{}
	cancelEvaluated map[string]struct{}
}

// NewTrader creates a new Noise Trader strategy handler.
// seeder must be non-nil; it is used to derive a deterministic per-bot per-session rng seed.
// decisionPipe must be non-nil; it is used to record every strategic decision.
// idLookup may be nil — in that case InternalID in decision logs will be absent.
func NewTrader(
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
) *Trader {
	return &Trader{
		configMgr:       configMgr,
		portStore:       portStore,
		sched:           sched,
		engine:          engine,
		clock:           clock,
		orderQ:          orderQ,
		ruleStore:       ruleStore,
		lookup:          lookup,
		idLookup:        idLookup,
		seeder:          seeder,
		decisionPipe:    decisionPipe,
		botRNGs:         make(map[string]*rand.Rand),
		botRNGLocks:     make(map[string]*sync.Mutex),
		botSessions:     make(map[string]uuid.UUID),
		cancelScheduled: make(map[string]struct{}),
		cancelEvaluated: make(map[string]struct{}),
	}
}

// HandleTask processes a scheduled tick for the noise trader.
// It is called by the scheduler on every tick and schedules the next tick before returning.
func (t *Trader) HandleTask(ctx context.Context, botID string, payload interface{}) error {
	// 1. Load bot config — this includes noise params and realism params.
	botConfig, _, err := t.configMgr.GetDBConfig(ctx, botID)
	if err != nil {
		return fmt.Errorf("failed to load bot config: %w", err)
	}

	if botConfig.StrategyType != "noise_trader" {
		return fmt.Errorf("invalid strategy type for bot %s: %s", botID, botConfig.StrategyType)
	}

	noiseCfg, err := ParseConfig(botConfig.Parameters)
	if err != nil {
		return fmt.Errorf("invalid noise config: %w", err)
	}
	t.scheduleRecoveredCancels(botID, noiseCfg)

	rules := t.ruleStore.Get()
	if rules == nil {
		return fmt.Errorf("market rules unavailable")
	}

	// 2. Derive per-bot per-session deterministic rng seed (BOT_STRATEGY_SPEC.md §5).
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
	}
	t.rngMu.Unlock()

	// Schedule next decision interval BEFORE any early-return paths so the loop
	// continues unless externally halted (bankrupt, disabled, etc.).
	defer t.scheduleNextTick(botID, noiseCfg, rng)

	// Helper: build the session context snapshot for decision logs.
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
			Strategy:          "noise_trader",
			SessionStatus:     sessionStatus,
			Action:            action,
			DecisionReason:    reason,
			ContextSnapshot:   snapshot,
			CreatedAt:         time.Now().UTC(),
		}
		if recErr := t.decisionPipe.Record(ctx, entry); recErr != nil {
			// Decision pipeline errors are non-fatal for the strategy tick.
			// The pipeline itself logs buffer-full events; we only silently discard here.
			_ = recErr
		}
	}

	// 3. Select Symbol from active universe.
	symbol, err := t.selectSymbol(noiseCfg.SymbolsUniverse, rules, rng)
	if err != nil {
		recordDecision(decision.ActionReject, "symbol_selection_failed", map[string]interface{}{
			"bot_id": botID, "error": err.Error(),
		})
		return err
	}

	// 4. Side + Inventory Bias.
	side := t.decideSide(botID, symbol, noiseCfg.BuyProbability, rng)

	// 5. Price — snap to valid tick before passing to realism engine.
	// realism.PlanDecision → rules.Resolve will clamp to ARA/ARB band and re-align.
	rawPrice, err := t.decidePrice(symbol, side, noiseCfg.MaxPriceDeviationPct, rules, rng)
	if err != nil {
		recordDecision(decision.ActionReject, "price_decision_failed", map[string]interface{}{
			"bot_id": botID, "symbol": symbol, "error": err.Error(),
		})
		return fmt.Errorf("failed to decide price: %w", err)
	}

	// 6. Quantity.
	quantityLots := sampleDistribution(noiseCfg.OrderSizeLots, rng)
	lotSize, ok := rules.LotSize(symbol)
	if !ok || lotSize <= 0 {
		recordDecision(decision.ActionReject, "lot_size_missing", map[string]interface{}{
			"bot_id": botID, "symbol": symbol,
		})
		return fmt.Errorf("lot size not found for symbol %s", symbol)
	}
	quantityShares := int64(quantityLots) * lotSize
	if quantityShares <= 0 {
		recordDecision(decision.ActionHold, "quantity_zero_skip", map[string]interface{}{
			"bot_id": botID, "symbol": symbol,
		})
		return nil
	}

	// Clamp by risk config max order size.
	if quantityLots > float64(botConfig.Risk.MaxOrderSizeLots) {
		quantityShares = int64(botConfig.Risk.MaxOrderSizeLots) * lotSize
	}

	// Ensure sufficient inventory for sell side.
	if side == "sell" {
		availShares := t.getAvailableShares(botID, symbol)
		if quantityShares > availShares {
			quantityShares = (availShares / lotSize) * lotSize
		}
		if quantityShares <= 0 {
			recordDecision(decision.ActionHold, "insufficient_inventory", map[string]interface{}{
				"bot_id": botID, "symbol": symbol, "side": side,
			})
			return nil
		}
	}

	// 7. Filter through Realism Engine (inactivity, abort, U-curve delay, fat finger, overreaction).
	intent := realism.OrderIntent{
		BotID:          botID,
		Symbol:         symbol,
		Side:           side,
		PriceIDR:       rawPrice,
		QuantityShares: quantityShares,
	}

	plan, err := t.engine.PlanDecision(t.clock, rules, botConfig.Human, botConfig.Activity, intent)
	if err != nil {
		if errors.Is(err, realism.ErrInactiveSegment) {
			recordDecision(decision.ActionHold, "inactive_segment", map[string]interface{}{
				"bot_id": botID, "symbol": symbol,
			})
			return nil
		}
		recordDecision(decision.ActionReject, "realism_plan_failed", map[string]interface{}{
			"bot_id": botID, "symbol": symbol, "error": err.Error(),
		})
		return fmt.Errorf("realism plan error: %w", err)
	}

	if plan.InactiveSession {
		recordDecision(decision.ActionHold, "inactive_session", map[string]interface{}{
			"bot_id": botID, "symbol": symbol,
		})
		return nil
	}

	if plan.Abort {
		recordDecision(decision.ActionHold, "decision_abort", map[string]interface{}{
			"bot_id": botID, "symbol": symbol, "side": side,
		})
		return nil
	}

	// 8. Enqueue Order — the resolved order from the realism engine has already been
	// tick-aligned and ARA/ARB-clamped by rules.Resolve inside PlanDecision.
	clientOrderID := fmt.Sprintf("bot:%s:%s:%d", botID, symbol, rng.Uint64())
	price := plan.Order.PriceIDR
	qty := plan.Order.QuantityShares

	recordDecision(decision.ActionPlaceOrder, "noise_trader_place", map[string]interface{}{
		"bot_id":          botID,
		"symbol":          symbol,
		"side":            side,
		"price_idr":       price,
		"quantity_shares": qty,
		"fat_finger":      plan.FatFingerApplied,
		"overreaction":    plan.OverreactionApplied,
		"client_order_id": clientOrderID,
	})

	schedPayload := delayedSubmitPayload{
		BotID:             botID,
		AccountID:         t.lookup(botID),
		Symbol:            symbol,
		Side:              side,
		PriceIDR:          price,
		QuantityShares:    qty,
		ClientOrderID:     clientOrderID,
		SessionInstanceID: sessionInstanceID,
		VirtualDayIndex:   virtualDayIndex,
		SessionStatus:     sessionStatus,
		InternalID:        internalID,
	}

	t.sched.Schedule(&scheduler.Task{
		BotID:     botID,
		ExecuteAt: time.Now().Add(plan.ReactionDelay),
		Payload:   schedPayload,
		Handler:   t.handleDelayedSubmit,
	})

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
			Strategy:          "noise_trader",
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

type delayedCancelPayload struct {
	BotID             string
	AccountID         string
	ClientOrderID     string
	InternalID        *uuid.UUID
	SessionInstanceID *uuid.UUID
	VirtualDayIndex   *int64
	SessionStatus     string
	Symbol            string
	NoiseCfg          Config
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
	if order.Status != portfolio.StatusOpen && order.Status != portfolio.StatusPartiallyFilled {
		return t.recordCancelHold(ctx, p, "cancel_order_not_authoritatively_open")
	}
	if order.RemainingQtyShares() <= 0 {
		return t.recordCancelHold(ctx, p, "cancel_order_no_remaining_quantity")
	}
	instance := t.clock.GetInstance()
	if instance == nil || instance.Status == session.StateNonCancellation {
		return t.recordCancelHold(ctx, p, "cancel_deferred_by_market_rule")
	}
	if orderRNG(p.ClientOrderID).Float64() >= p.NoiseCfg.CancelProbability {
		t.markCancelEvaluated(p.ClientOrderID)
		return t.recordCancelHold(ctx, p, "cancel_probability_not_selected")
	}
	t.markCancelEvaluated(p.ClientOrderID)

	req := &queue.OrderRequest{
		ClientOrderID: p.ClientOrderID + ":cancel:1",
		BotID:         p.BotID,
		Priority:      queue.PriorityRiskCancel, // Cancels have highest priority
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
			Strategy:          "noise_trader",
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
		VirtualDayIndex: p.VirtualDayIndex, Strategy: "noise_trader",
		Symbol: p.Symbol, SessionStatus: p.SessionStatus, Action: decision.ActionHold,
		DecisionReason: reason, ClientOrderID: &p.ClientOrderID,
		ContextSnapshot: map[string]interface{}{"bot_id": p.BotID},
		CreatedAt:       time.Now().UTC(),
	}
	return t.decisionPipe.Record(ctx, entry)
}

func (t *Trader) scheduleRecoveredCancels(botID string, cfg Config) {
	accountID := t.lookup(botID)
	if accountID == "" {
		return
	}
	for _, order := range t.portStore.OpenLocalOrders(accountID) {
		if order.Status != portfolio.StatusOpen && order.Status != portfolio.StatusPartiallyFilled {
			continue
		}
		t.scheduleCancel(botID, accountID, order, cfg)
	}
}

func (t *Trader) scheduleCancel(botID, accountID string, order portfolio.LocalOrder, cfg Config) {
	if order.OpenedAt.IsZero() {
		return
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
	virtualAge := time.Duration(sampleDistribution(cfg.CancelAfterVirtualMinutes, rng) * float64(time.Minute))
	due := order.OpenedAt.Add(t.clock.VirtualToRealDelay(virtualAge))
	if due.Before(time.Now()) {
		due = time.Now()
	}
	t.sched.Schedule(&scheduler.Task{
		BotID: botID, ExecuteAt: due,
		Payload: delayedCancelPayload{
			BotID: botID, AccountID: accountID, ClientOrderID: order.ClientOrderID,
			Symbol: order.Symbol, NoiseCfg: cfg,
		},
		Handler: t.handleDelayedCancel,
	})
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
		delay = time.Second // minimum tick interval 1s real-time
	}

	task := &scheduler.Task{
		BotID:     botID,
		ExecuteAt: time.Now().Add(delay),
		Handler:   t.HandleTask,
	}
	t.sched.Schedule(task)
}

// selectSymbol picks a symbol from the configured universe.
//
// Universe type behaviour:
//   - "all_active" / "" : pick uniformly from all listed symbols in the current rule snapshot.
//   - "random_n"        : pick uniformly from n random symbols drawn from the full listed set.
//   - "fixed"           : pick from the static list in cfg.Symbols (pre-validated at config parse).
//   - "sector"          : sector metadata is not yet available in SnapshotResolver (planned Fase 5);
//     fall back to all_active and log the limitation.
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
		// Sample without replacement then pick one of the sampled n.
		// We shuffle a copy so the original slice ordering is stable.
		sampled := make([]string, len(allSymbols))
		copy(sampled, allSymbols)
		rng.Shuffle(len(sampled), func(i, j int) { sampled[i], sampled[j] = sampled[j], sampled[i] })
		return sampled[rng.Intn(n)], nil

	case "sector":
		// Sector metadata is not yet encoded in SnapshotResolver (Fase 5 scope).
		// Fall back to all_active so the bot remains operational rather than error-looping.
		// This is acceptable for MVP because sector filtering is a Fase 5 feature.
		fallthrough

	default: // "all_active" and any unknown type
		allSymbols := rules.ListedSymbols()
		if len(allSymbols) == 0 {
			return "", fmt.Errorf("no listed symbols available in current rule snapshot")
		}
		return allSymbols[rng.Intn(len(allSymbols))], nil
	}
}

func (t *Trader) decideSide(botID, symbol string, buyProb float64, rng *rand.Rand) string {
	availShares := t.getAvailableShares(botID, symbol)
	// Inventory bias: if we hold shares, reduce buy probability slightly.
	// Per BOT_STRATEGY_SPEC.md §7: "Side probability dipengaruhi inventory dalam batas tertentu."
	if availShares > 0 {
		buyProb = buyProb * 0.8
	}

	if rng.Float64() < buyProb {
		return "buy"
	}
	return "sell"
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

// decidePrice computes a raw target price within the configured deviation from last price,
// then snaps it to the nearest valid tick for the given side.
//
// realism.PlanDecision → rules.Resolve will subsequently clamp the tick-snapped price to
// the ARA/ARB band and realign to lot size — so the price the bot submits is always valid.
func (t *Trader) decidePrice(symbol, side string, devPct float64, rules *marketrules.SnapshotResolver, rng *rand.Rand) (int64, error) {
	lastPrice, ok := rules.LastPriceIDR(symbol)
	if !ok || lastPrice <= 0 {
		return 0, fmt.Errorf("no last price for %s", symbol)
	}

	// Random deviation in [-devPct, +devPct]
	deviation := (rng.Float64()*2 - 1) * devPct
	target := int64(math.Round(float64(lastPrice) * (1.0 + deviation)))
	if target <= 0 {
		target = 1
	}

	// Snap to nearest valid tick before handing off to realism engine.
	// (realism.PlanDecision will still clamp to ARA/ARB and realign, but snapping here
	// ensures the deviation intent is expressed as a valid limit price.)
	security, ok := rules.SecurityRules(symbol)
	if ok {
		target = marketrules.GetValidPriceTick(target, security.TickRules, side)
	}

	return target, nil
}

// sampleDistribution converts our configured distribution to a float64 sample.
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

// Ensure *decision.Pipeline satisfies DecisionRecorder at compile time.
var _ DecisionRecorder = (*decision.Pipeline)(nil)
