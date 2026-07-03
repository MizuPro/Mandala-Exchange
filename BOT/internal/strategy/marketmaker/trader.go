package marketmaker

import (
	"context"
	"fmt"
	"math"
	"math/rand"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Mandala-Exchange/BOT/internal/antipredict"
	"github.com/Mandala-Exchange/BOT/internal/config"
	"github.com/Mandala-Exchange/BOT/internal/decision"
	"github.com/Mandala-Exchange/BOT/internal/marketrules"
	"github.com/Mandala-Exchange/BOT/internal/portfolio"
	"github.com/Mandala-Exchange/BOT/internal/queue"
	"github.com/Mandala-Exchange/BOT/internal/realism"
	"github.com/Mandala-Exchange/BOT/internal/scheduler"
)

// AccountLookup defines how the strategy looks up the sekuritas account ID for a bot.
type AccountLookup func(botID string) string

// InternalIDLookup returns the internal UUID of a bot by its external bot ID.
type InternalIDLookup func(botID string) *uuid.UUID

// DecisionRecorder is the subset of *decision.Pipeline used by Trader.
type DecisionRecorder interface {
	Record(ctx context.Context, entry decision.DecisionLog) error
}

// Trader implements the Market Maker strategy handler.
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

	botRNGs     map[string]*rand.Rand
	botRNGLocks map[string]*sync.Mutex
	botSessions map[string]uuid.UUID
	botSymbols  map[string]string // Dynamically assigned symbols for bots with empty Symbol config
	rngMu       sync.Mutex
}

// NewTrader creates a new Market Maker trader strategy instance.
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
) *Trader {
	return &Trader{
		dbPool:       dbPool,
		configMgr:    configMgr,
		portStore:    portStore,
		sched:        sched,
		engine:       engine,
		clock:        clock,
		orderQ:       orderQ,
		ruleStore:    ruleStore,
		lookup:       lookup,
		idLookup:     idLookup,
		seeder:       seeder,
		decisionPipe: decisionPipe,
		botRNGs:      make(map[string]*rand.Rand),
		botRNGLocks:  make(map[string]*sync.Mutex),
		botSessions:  make(map[string]uuid.UUID),
		botSymbols:   make(map[string]string),
	}
}

// OnMarketEvent handles market events routed from main.
func (t *Trader) OnMarketEvent(event interface{}) {
	// Currently no-op. SnapshotStore is updated via updateMarketPrice,
	// so the trader retrieves current order book from t.sched.Snapshots.Get().
}

// HandleTask processes the periodic refresh tick for a Market Maker bot.
func (t *Trader) HandleTask(ctx context.Context, botID string, payload interface{}) error {
	botConfig, _, err := t.configMgr.GetDBConfig(ctx, botID)
	if err != nil {
		return fmt.Errorf("failed to load bot config: %w", err)
	}

	if botConfig.StrategyType != "market_maker" {
		return fmt.Errorf("invalid strategy type for bot %s: %s", botID, botConfig.StrategyType)
	}

	if botConfig.Status == "disabled" || botConfig.Status == "bankrupt" {
		return nil // Stop trading and do NOT reschedule next tick
	}

	cfg, err := ParseConfig(botConfig.Parameters)
	if err != nil {
		return fmt.Errorf("invalid market maker config: %w", err)
	}

	// Reschedule next tick defer
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

	defer t.scheduleNextTick(botID, cfg, rng)

	// Decision logging helper
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
			Strategy:          "market_maker",
			SessionStatus:     sessionStatus,
			Action:            action,
			DecisionReason:    reason,
			ContextSnapshot:   snapshot,
			CreatedAt:         time.Now().UTC(),
		}
		_ = t.decisionPipe.Record(ctx, entry)
	}

	rules := t.ruleStore.Get()
	if rules == nil {
		recordDecision(decision.ActionHold, "market_rules_unavailable", nil)
		return fmt.Errorf("market rules unavailable")
	}

	targetSymbol := cfg.Symbol
	if targetSymbol == "" {
		t.rngMu.Lock()
		assigned, hasAssigned := t.botSymbols[botID]
		t.rngMu.Unlock()

		if !hasAssigned {
			assigned = t.selectDynamicSymbol(cfg, rules, rng)
			if assigned == "" {
				recordDecision(decision.ActionHold, "no_eligible_symbols", nil)
				return nil
			}
			t.rngMu.Lock()
			t.botSymbols[botID] = assigned
			t.rngMu.Unlock()
		}
		targetSymbol = assigned
	}
	cfg.Symbol = targetSymbol

	boardRules, ok := rules.SecurityRules(cfg.Symbol)
	if !ok {
		recordDecision(decision.ActionHold, "security_rules_not_found", map[string]interface{}{"symbol": cfg.Symbol})
		return fmt.Errorf("security rules not found for symbol: %s", cfg.Symbol)
	}

	snapshot, ok := t.sched.Snapshots.Get(cfg.Symbol)
	if !ok {
		recordDecision(decision.ActionHold, "market_snapshot_unavailable", map[string]interface{}{"symbol": cfg.Symbol})
		return nil // Non-fatal wait
	}

	// Map scheduler levels to marketmaker levels
	currentBids := make([]BookLevel, len(snapshot.Bids))
	for i, b := range snapshot.Bids {
		currentBids[i] = BookLevel{Price: b.Price, Quantity: b.Quantity}
	}
	currentAsks := make([]BookLevel, len(snapshot.Asks))
	for i, a := range snapshot.Asks {
		currentAsks[i] = BookLevel{Price: a.Price, Quantity: a.Quantity}
	}

	// 1. Fetch current inventory & accountID
	accountID := t.lookup(botID)
	if accountID == "" {
		recordDecision(decision.ActionHold, "missing_account_id", nil)
		return fmt.Errorf("missing Sekuritas account mapping for bot %s", botID)
	}

	// 2. Validate Session Status (Task 4.4.5)
	if instance == nil {
		recordDecision(decision.ActionHold, "session_instance_unavailable", nil)
		return nil
	}

	sessionAllowed := false
	switch instance.Status {
	case "continuous", "pre_close":
		sessionAllowed = true
	}

	if !sessionAllowed {
		recordDecision(decision.ActionHold, "session_not_active_for_strategy", map[string]interface{}{
			"session_status": instance.Status,
		})
		return nil
	}

	var inventoryLots int64 = 0
	if acc, ok := t.portStore.Account(accountID); ok {
		for _, pos := range acc.Positions {
			if strings.ToUpper(pos.Symbol) == strings.ToUpper(cfg.Symbol) {
				inventoryLots = pos.AvailableShares / boardRules.LotSize
				break
			}
		}
	}

	// 3. Generate Desired Quotes
	spreadTicks := int(SampleDistribution(cfg.SpreadTicks, rng))
	levelSizeLots := int(SampleDistribution(cfg.LevelSizeLots, rng))

	bids, asks, err := GenerateQuotes(
		cfg.Symbol,
		cfg,
		currentBids,
		currentAsks,
		snapshot.Price,
		inventoryLots,
		rules,
		spreadTicks,
		levelSizeLots,
	)
	if err != nil {
		recordDecision(decision.ActionHold, "quote_generation_failed", map[string]interface{}{
			"error": err.Error(),
		})
		return fmt.Errorf("quote generation failed: %w", err)
	}

	// Format quotes for logging and recording decision
	bidsSnapshot := make([]map[string]interface{}, len(bids))
	for i, q := range bids {
		bidsSnapshot[i] = map[string]interface{}{"price": q.Price, "quantity": q.Quantity}
	}
	asksSnapshot := make([]map[string]interface{}, len(asks))
	for i, q := range asks {
		asksSnapshot[i] = map[string]interface{}{"price": q.Price, "quantity": q.Quantity}
	}

	recordDecision(decision.ActionPlaceOrder, "quotes_generated", map[string]interface{}{
		"symbol":         cfg.Symbol,
		"inventory_lots": inventoryLots,
		"bids":           bidsSnapshot,
		"asks":           asksSnapshot,
	})

	// 4. Fetch Live Outstanding Orders (Task 4.4.3)
	openOrders := t.portStore.OpenLocalOrders(accountID)
	liveBids := make([]*portfolio.LocalOrder, cfg.Levels)
	liveAsks := make([]*portfolio.LocalOrder, cfg.Levels)
	var extraOrders []portfolio.LocalOrder

	for _, order := range openOrders {
		if strings.ToUpper(order.Symbol) != strings.ToUpper(cfg.Symbol) {
			continue
		}
		side, lvl, ok := parseMMOrderID(order.ClientOrderID)
		if !ok {
			// Cancel non-MM orders on this account/symbol to keep state clean
			extraOrders = append(extraOrders, order)
			continue
		}
		if lvl < 0 || lvl >= cfg.Levels {
			extraOrders = append(extraOrders, order)
			continue
		}

		ordCopy := order
		if side == "buy" {
			liveBids[lvl] = &ordCopy
		} else if side == "sell" {
			liveAsks[lvl] = &ordCopy
		} else {
			extraOrders = append(extraOrders, order)
		}
	}

	// 5. Cancel extra/out-of-bounds orders
	for _, order := range extraOrders {
		t.submitCancel(botID, accountID, order.ClientOrderID)
	}

	// 6. Refresh Bids (desired-versus-live diffing) (Task 4.4.4)
	buyRate, _ := getFeeRates(cfg.Symbol, rules)
	for i := 0; i < cfg.Levels; i++ {
		desiredBid := bids[i]
		liveBid := liveBids[i]

		if desiredBid.Quantity <= 0 {
			if liveBid != nil {
				t.submitCancel(botID, accountID, liveBid.ClientOrderID)
			}
		} else {
			estimatedFee := int64(math.Ceil(float64(desiredBid.Price*desiredBid.Quantity) * buyRate))
			totalCost := desiredBid.Price*desiredBid.Quantity + estimatedFee

			if liveBid == nil {
				// Place new bid order
				newClientOrderID := fmt.Sprintf("bot:%s:%s:mm:buy:%d:%s:%d", botID, cfg.Symbol, i, sessionID.String(), rng.Uint64())
				reserveErr := t.portStore.ReserveCashForBuy(accountID, totalCost, newClientOrderID)
				if reserveErr != nil {
					recordDecision(decision.ActionHold, "insufficient_funds_for_bid", map[string]interface{}{
						"level": i, "price": desiredBid.Price, "quantity": desiredBid.Quantity, "error": reserveErr.Error(),
					})
				} else {
					_ = t.portStore.TrackLocalOrder(&portfolio.LocalOrder{
						ClientOrderID:     newClientOrderID,
						AccountID:         accountID,
						Symbol:            cfg.Symbol,
						Side:              "buy",
						OrderType:         "limit",
						PriceIDR:          desiredBid.Price,
						OriginalQtyShares: desiredBid.Quantity,
						Status:            portfolio.StatusQueued,
					})
					submitErr := t.orderQ.Submit(&queue.OrderRequest{
						ClientOrderID: newClientOrderID,
						BotID:         botID,
						Priority:      queue.PriorityMarketMakerRefresh,
						Payload: queue.SubmitOrderPayload{
							AccountID: accountID,
							Symbol:    cfg.Symbol,
							Side:      "buy",
							PriceIDR:  desiredBid.Price,
							Quantity:  desiredBid.Quantity,
						},
						ExpiresAt: time.Now().Add(15 * time.Second),
					})
					if submitErr != nil {
						_ = t.portStore.UpdateLocalOrderStatus(newClientOrderID, portfolio.StatusExpiredBeforeSubmit)
						recordDecision(decision.ActionReject, "queue_submit_failed_for_bid", map[string]interface{}{
							"level": i, "client_order_id": newClientOrderID, "error": submitErr.Error(),
						})
					}
				}
			} else {
				if liveBid.Status == portfolio.StatusSubmitUnknown {
					// submit_unknown: cancel first, wait for next tick to place
					t.submitCancel(botID, accountID, liveBid.ClientOrderID)
				} else if liveBid.Status == portfolio.StatusOpen || liveBid.Status == portfolio.StatusPartiallyFilled {
					if liveBid.PriceIDR == desiredBid.Price && liveBid.RemainingQtyShares() == desiredBid.Quantity {
						// Keep
					} else {
						// Amend Price & Quantity
						amendErr := t.portStore.AmendCashReservation(accountID, liveBid.ClientOrderID, totalCost)
						if amendErr != nil {
							recordDecision(decision.ActionHold, "amend_reservation_failed_for_bid", map[string]interface{}{
								"level": i, "client_order_id": liveBid.ClientOrderID, "price": desiredBid.Price, "quantity": desiredBid.Quantity, "error": amendErr.Error(),
							})
						} else {
							submitErr := t.orderQ.Submit(&queue.OrderRequest{
								ClientOrderID: liveBid.ClientOrderID + ":amend:1",
								BotID:         botID,
								Priority:      queue.PriorityMarketMakerRefresh,
								Payload: queue.AmendOrderPayload{
									AccountID:     accountID,
									ClientOrderID: liveBid.ClientOrderID,
									PriceIDR:      desiredBid.Price,
									Quantity:      desiredBid.Quantity,
								},
								ExpiresAt: time.Now().Add(15 * time.Second),
							})
							if submitErr != nil {
								recordDecision(decision.ActionReject, "queue_amend_submit_failed_for_bid", map[string]interface{}{
									"level": i, "client_order_id": liveBid.ClientOrderID, "error": submitErr.Error(),
								})
							}
						}
					}
				}
			}
		}
	}

	// 7. Refresh Asks (desired-versus-live diffing) (Task 4.4.4)
	for i := 0; i < cfg.Levels; i++ {
		desiredAsk := asks[i]
		liveAsk := liveAsks[i]

		if desiredAsk.Quantity <= 0 {
			if liveAsk != nil {
				t.submitCancel(botID, accountID, liveAsk.ClientOrderID)
			}
		} else {
			if liveAsk == nil {
				// Place new ask order
				newClientOrderID := fmt.Sprintf("bot:%s:%s:mm:sell:%d:%s:%d", botID, cfg.Symbol, i, sessionID.String(), rng.Uint64())
				reserveErr := t.portStore.ReserveSharesForSell(accountID, cfg.Symbol, desiredAsk.Quantity, newClientOrderID)
				if reserveErr != nil {
					recordDecision(decision.ActionHold, "insufficient_shares_for_ask", map[string]interface{}{
						"level": i, "price": desiredAsk.Price, "quantity": desiredAsk.Quantity, "error": reserveErr.Error(),
					})
				} else {
					_ = t.portStore.TrackLocalOrder(&portfolio.LocalOrder{
						ClientOrderID:     newClientOrderID,
						AccountID:         accountID,
						Symbol:            cfg.Symbol,
						Side:              "sell",
						OrderType:         "limit",
						PriceIDR:          desiredAsk.Price,
						OriginalQtyShares: desiredAsk.Quantity,
						Status:            portfolio.StatusQueued,
					})
					submitErr := t.orderQ.Submit(&queue.OrderRequest{
						ClientOrderID: newClientOrderID,
						BotID:         botID,
						Priority:      queue.PriorityMarketMakerRefresh,
						Payload: queue.SubmitOrderPayload{
							AccountID: accountID,
							Symbol:    cfg.Symbol,
							Side:      "sell",
							PriceIDR:  desiredAsk.Price,
							Quantity:  desiredAsk.Quantity,
						},
						ExpiresAt: time.Now().Add(15 * time.Second),
					})
					if submitErr != nil {
						_ = t.portStore.UpdateLocalOrderStatus(newClientOrderID, portfolio.StatusExpiredBeforeSubmit)
						recordDecision(decision.ActionReject, "queue_submit_failed_for_ask", map[string]interface{}{
							"level": i, "client_order_id": newClientOrderID, "error": submitErr.Error(),
						})
					}
				}
			} else {
				if liveAsk.Status == portfolio.StatusSubmitUnknown {
					t.submitCancel(botID, accountID, liveAsk.ClientOrderID)
				} else if liveAsk.Status == portfolio.StatusOpen || liveAsk.Status == portfolio.StatusPartiallyFilled {
					if liveAsk.PriceIDR == desiredAsk.Price && liveAsk.RemainingQtyShares() == desiredAsk.Quantity {
						// Keep
					} else {
						// Amend Price & Quantity
						amendErr := t.portStore.AmendShareReservation(accountID, liveAsk.ClientOrderID, desiredAsk.Quantity)
						if amendErr != nil {
							recordDecision(decision.ActionHold, "amend_reservation_failed_for_ask", map[string]interface{}{
								"level": i, "client_order_id": liveAsk.ClientOrderID, "price": desiredAsk.Price, "quantity": desiredAsk.Quantity, "error": amendErr.Error(),
							})
						} else {
							submitErr := t.orderQ.Submit(&queue.OrderRequest{
								ClientOrderID: liveAsk.ClientOrderID + ":amend:1",
								BotID:         botID,
								Priority:      queue.PriorityMarketMakerRefresh,
								Payload: queue.AmendOrderPayload{
									AccountID:     accountID,
									ClientOrderID: liveAsk.ClientOrderID,
									PriceIDR:      desiredAsk.Price,
									Quantity:      desiredAsk.Quantity,
								},
								ExpiresAt: time.Now().Add(15 * time.Second),
							})
							if submitErr != nil {
								recordDecision(decision.ActionReject, "queue_amend_submit_failed_for_ask", map[string]interface{}{
									"level": i, "client_order_id": liveAsk.ClientOrderID, "error": submitErr.Error(),
								})
							}
						}
					}
				}
			}
		}
	}

	return nil
}

// selectDynamicSymbol picks a symbol based on the configured SymbolsUniverse.
func (t *Trader) selectDynamicSymbol(cfg Config, rules *marketrules.SnapshotResolver, rng *rand.Rand) string {
	switch cfg.SymbolsUniverse.Type {
	case "fixed":
		if len(cfg.SymbolsUniverse.Symbols) > 0 {
			return cfg.SymbolsUniverse.Symbols[rng.Intn(len(cfg.SymbolsUniverse.Symbols))]
		}
		return ""
	case "random_n":
		allSymbols := rules.ListedSymbols()
		if len(allSymbols) == 0 {
			return ""
		}
		n := 1
		if cfg.SymbolsUniverse.Count != nil && *cfg.SymbolsUniverse.Count > 0 {
			n = *cfg.SymbolsUniverse.Count
		}
		if n > len(allSymbols) {
			n = len(allSymbols)
		}
		sampled := make([]string, len(allSymbols))
		copy(sampled, allSymbols)
		rng.Shuffle(len(sampled), func(i, j int) { sampled[i], sampled[j] = sampled[j], sampled[i] })
		return sampled[rng.Intn(n)]
	default:
		allSymbols := rules.ListedSymbols()
		if len(allSymbols) == 0 {
			return ""
		}
		return allSymbols[rng.Intn(len(allSymbols))]
	}
}

func (t *Trader) scheduleNextTick(botID string, cfg Config, rng *rand.Rand) {
	intervalSecs := SampleDistribution(cfg.RefreshVirtualSeconds, rng)
	delay := t.clock.VirtualToRealDelay(time.Duration(intervalSecs * float64(time.Second)))
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

func (t *Trader) submitCancel(botID, accountID, clientOrderID string) {
	req := &queue.OrderRequest{
		ClientOrderID: clientOrderID + ":cancel:1",
		BotID:         botID,
		Priority:      queue.PriorityRiskCancel, // Cancel has high priority
		Payload: queue.CancelOrderPayload{
			AccountID:     accountID,
			ClientOrderID: clientOrderID,
		},
		ExpiresAt: time.Now().Add(10 * time.Second),
	}
	_ = t.orderQ.Submit(req)
}

func parseMMOrderID(clientOrderID string) (side string, level int, ok bool) {
	// e.g. bot:mm-001:BBCA:mm:buy:0:session-uuid:nonce
	parts := strings.Split(clientOrderID, ":")
	if len(parts) < 6 {
		return "", 0, false
	}
	if parts[3] != "mm" {
		return "", 0, false
	}
	side = parts[4]
	levelVal := parts[5]
	var l int
	_, err := fmt.Sscan(levelVal, &l)
	if err != nil {
		return "", 0, false
	}
	return side, l, true
}
