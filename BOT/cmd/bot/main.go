package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Mandala-Exchange/BOT/internal/antipredict"
	"github.com/Mandala-Exchange/BOT/internal/circuitbreaker"
	beiClient "github.com/Mandala-Exchange/BOT/internal/client/bei"
	"github.com/Mandala-Exchange/BOT/internal/client/mats"
	"github.com/Mandala-Exchange/BOT/internal/client/sekuritas"
	"github.com/Mandala-Exchange/BOT/internal/config"
	"github.com/Mandala-Exchange/BOT/internal/decision"
	"github.com/Mandala-Exchange/BOT/internal/eventcontext"
	"github.com/Mandala-Exchange/BOT/internal/logger"
	"github.com/Mandala-Exchange/BOT/internal/marketrules"
	"github.com/Mandala-Exchange/BOT/internal/metrics"
	"github.com/Mandala-Exchange/BOT/internal/portfolio"
	"github.com/Mandala-Exchange/BOT/internal/queue"
	"github.com/Mandala-Exchange/BOT/internal/realism"
	"github.com/Mandala-Exchange/BOT/internal/reconciliation"
	"github.com/Mandala-Exchange/BOT/internal/risk"
	"github.com/Mandala-Exchange/BOT/internal/scheduler"
	"github.com/Mandala-Exchange/BOT/internal/sentiment"
	"github.com/Mandala-Exchange/BOT/internal/session"
	"github.com/Mandala-Exchange/BOT/internal/strategy/noise"
	"github.com/Mandala-Exchange/BOT/internal/strategystate"
)

type registeredBot struct {
	InternalID uuid.UUID
	BotID      string
	AccountID  string
}

type liquidationPayload struct {
	AccountID string
	Symbol    string
	Quantity  int64
}

func optionalUUID(id uuid.UUID) *uuid.UUID {
	if id == uuid.Nil {
		return nil
	}
	return &id
}

func main() {
	// ── Layer 1: Compiled defaults (in config package constants)
	// ── Layer 2: Environment variables
	cfg, err := config.LoadEnv()
	if err != nil {
		log.Fatal(err)
	}
	sessionSeeder, err := antipredict.NewSeeder([]byte(cfg.SessionSeedSecret), "bot-v1")
	if err != nil {
		log.Fatal(err)
	}

	logger.Info("Starting BOT Service", map[string]interface{}{
		"env":  cfg.AppEnv,
		"port": cfg.HTTPAddr,
	})

	// ── Database Connection Pool (max 15 connections per Task 1.3/1.5)
	dbConfig, err := pgxpool.ParseConfig(cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("Unable to parse database url: %v", err)
	}
	dbConfig.MaxConns = 15 // Exit criteria: DB connection pool maximum default 15

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	dbPool, err := pgxpool.NewWithConfig(ctx, dbConfig)
	if err != nil {
		log.Fatalf("Unable to create connection pool: %v", err)
	}
	defer dbPool.Close()

	if err := dbPool.Ping(ctx); err != nil {
		log.Fatalf("Unable to connect to database: %v\n(Hint: BOT DB must be running on port 5435)", err)
	}

	// ── Config Manager (Layers 3 & 4: DB config + runtime override)
	configMgr := config.NewConfigManager(dbPool)
	_ = configMgr // Layer 3 (DB) and Layer 4 (runtime override) used via admin API (Fase 6)

	// Strategy memory is local BOT state, distinct from authoritative account
	// state in Sekuritas. Restore it before any strategy producer can start.
	strategyStateMgr := strategystate.NewManager(strategystate.NewPostgresRepository(dbPool))
	if err := strategyStateMgr.Restore(ctx); err != nil {
		log.Fatalf("Unable to restore strategy state: %v", err)
	}

	// ── Circuit Breaker & Readiness State Machine
	breakerMgr := circuitbreaker.NewBreakerManager()
	breakerMgr.SetState(circuitbreaker.StateSyncing)

	// ── Scheduler (4–8 strategy workers per PRD)
	sched := scheduler.NewScheduler(8)

	// ── Order Queue (10 workers, 5000 capacity per PRD)
	orderQ := queue.NewOrderQueue(10, 5000)

	// ── External Clients
	sekuritasClient := sekuritas.NewClient(cfg.SekuritasBaseURL, cfg.ServiceToken)
	matsClient := mats.NewClient(cfg.MatsWSURL, cfg.ServiceToken)
	beiClient := beiClient.NewClient(cfg.BeiBaseURL, cfg.ServiceToken)

	// ── Initial BEI Discovery Snapshot (fail-fast at startup)
	discoveryCtx, discoveryCancel := context.WithTimeout(ctx, 10*time.Second)
	if err := beiClient.FetchData(discoveryCtx); err != nil {
		discoveryCancel()
		log.Fatalf("Unable to load initial BEI discovery snapshot: %v", err)
	}
	discoveryCancel()
	symbols, err := beiClient.ListedSymbols()
	if err != nil {
		log.Fatalf("Unable to build active universe: %v", err)
	}
	matsClient.Configure(symbols, func(event mats.Event) {
		updateMarketPrice(sched.Snapshots, event)
	})

	// Compile the active BEI rule/fee snapshot. Missing rules fail startup closed.
	beiSnapshot, ok := beiClient.Snapshot()
	if !ok {
		log.Fatal("BEI snapshot unavailable after successful discovery")
	}
	ruleResolver, err := marketrules.NewSnapshotResolver(
		beiSnapshot.Securities, beiSnapshot.Rules, beiSnapshot.Fees, beiSnapshot.RulesAt,
	)
	if err != nil {
		log.Fatalf("Invalid active BEI rule snapshot: %v", err)
	}
	for _, symbol := range symbols {
		price, priceOK := ruleResolver.LastPriceIDR(symbol)
		lot, lotOK := ruleResolver.LotSize(symbol)
		if !priceOK || !lotOK {
			log.Fatalf("Missing active price/lot rule for %s", symbol)
		}
		sched.Snapshots.Publish(scheduler.MarketSnapshot{
			Symbol: symbol, Price: price, LotSize: lot,
			RulesVersion: beiSnapshot.RulesAt.UTC().Format(time.RFC3339Nano),
			LastUpdate:   beiSnapshot.SecuritiesAt,
		})
	}

	ruleStore := marketrules.NewStore()
	ruleStore.Update(ruleResolver)

	// ── Portfolio Store & Account Registry
	portfolioStore := portfolio.NewStore()
	rows, err := dbPool.Query(ctx,
		`SELECT internal_id, external_bot_id, sekuritas_account_id::text FROM bots
		 WHERE sekuritas_account_id IS NOT NULL AND status NOT IN ('disabled','bankrupt')`)
	if err != nil {
		log.Fatalf("Unable to load BOT account registry: %v", err)
	}
	var accountIDs []string
	var registeredBots []registeredBot
	internalIDByBotID := make(map[string]uuid.UUID)
	for rows.Next() {
		var bot registeredBot
		if err := rows.Scan(&bot.InternalID, &bot.BotID, &bot.AccountID); err != nil {
			rows.Close()
			log.Fatalf("Unable to scan BOT account registry: %v", err)
		}
		accountIDs = append(accountIDs, bot.AccountID)
		registeredBots = append(registeredBots, bot)
		internalIDByBotID[bot.BotID] = bot.InternalID
	}
	rows.Close()

	// ── Task 2.2: Genesis Startup Gate ──────────────────────────────────────────
	// Per BOT_MAIN_PLAN.md Task 2.2: Service tidak ready sampai hasil genesis/
	// reconciliation konsisten. Genesis hanya dijalankan melalui explicit admin action.
	//
	// At startup we check whether a completed genesis_run exists:
	//   - If bots are registered but no completed genesis: log warning, service
	//     starts in limited mode (won't transition to StateReady until genesis done).
	//   - If no bots are registered: fresh install; genesis not yet required.
	//   - If completed genesis exists: proceed normally.
	genesisCompleted := checkGenesisCompleted(ctx, dbPool, len(accountIDs))

	// ── Token Batch (short-lived JWTs for all active bots)
	if len(accountIDs) > 0 {
		tokenCtx, tokenCancel := context.WithTimeout(ctx, 10*time.Second)
		err = sekuritasClient.FetchTokens(tokenCtx, accountIDs,
			"startup-token-batch-"+time.Now().UTC().Format("200601021504"))
		tokenCancel()
		if err != nil {
			log.Fatalf("Unable to issue BOT JWT batch: %v", err)
		}

		// ── Task 2.1: Start staggered JWT refresh goroutine.
		// Refreshes tokens 5–10 minutes before expiry with per-account jitter.
		// Revoked/suspended account tokens are dropped from cache when refresh fails.
		// Token strings must NOT appear in logs.
		sekuritasClient.StartTokenRefresher(ctx, accountIDs)
	}

	// ── Reconciliation & Stream Consumer
	reconciler := reconciliation.NewReconciler(sekuritasClient, portfolioStore, accountIDs, 60*time.Second)
	streamConsumer := reconciliation.NewStreamConsumer(sekuritasClient, portfolioStore, reconciler)

	// Task 3.5 sentiment runtime. State is versioned in BOT PostgreSQL and
	// contains only global/sector context; contagion consumes public market data.
	sentimentRepo := sentiment.NewPostgresRepository(ctx, dbPool)
	sentimentService := sentiment.NewService(sentimentRepo)
	if err := sentimentService.Load(ctx); err != nil {
		log.Fatalf("Unable to load sentiment state: %v", err)
	}

	// ── Task 4.1: Decision Log Pipeline
	decisionConfig := decision.Config{
		BatchSize:         cfg.DecisionLogBatchSize,
		FlushInterval:     cfg.DecisionLogFlushInterval,
		HoldSampleRate:    cfg.DecisionLogHoldSampleRate,
		RetentionSessions: cfg.DecisionLogRetentionSessions,
		BufferCapacity:    cfg.DecisionLogBatchSize * 5,
	}
	decisionPipeline, err := decision.NewPipeline(dbPool, decisionConfig)
	if err != nil {
		log.Fatalf("Unable to initialize decision log pipeline: %v", err)
	}
	defer decisionPipeline.Close()
	recordDecision := func(entry decision.DecisionLog) {
		if recordErr := decisionPipeline.Record(ctx, entry); recordErr != nil {
			logger.Error("Unable to queue material decision log", map[string]interface{}{
				"action": string(entry.Action), "error": recordErr.Error(),
			})
		}
	}
	markDependencyStale := func(name, reason string) {
		wasStale := breakerMgr.HasStaleDependency(name)
		breakerMgr.MarkDependencyStale(name)
		if !wasStale {
			recordDecision(decision.DecisionLog{
				Action: decision.ActionBreaker, DecisionReason: reason,
				ContextSnapshot: map[string]interface{}{"dependency": name, "state": circuitbreaker.StateDegraded},
			})
		}
	}
	orderQ.SetExpirationHandler(func(req *queue.OrderRequest) {
		internalID := internalIDByBotID[req.BotID]
		recordDecision(decision.DecisionLog{
			InternalID: optionalUUID(internalID), Strategy: "system",
			Action: decision.ActionExpiredQueue, DecisionReason: "queue_ttl_elapsed",
			ClientOrderID:   &req.ClientOrderID,
			ContextSnapshot: map[string]interface{}{"priority": req.Priority},
		})
	})

	// ── Task 2.8: Session Monitor — wired to BEI session instance.
	// BEI is the owner and persistence authority for session_instance_id.
	// Monitor is updated every time BEI data is refreshed (see BEI refresh goroutine).
	// Rollover callback triggers daily reset for BOT strategy state.
	sessMonitor := session.NewMonitor()
	eventStore := eventcontext.NewStore()
	sessMonitor.OnRollover(func(previous, current session.SessionInstance) {
		logger.Info("Session rollover detected", map[string]interface{}{
			"previous_instance_id": previous.InstanceID.String(),
			"current_instance_id":  current.InstanceID.String(),
			"previous_day_index":   previous.VirtualDayIndex,
			"current_day_index":    current.VirtualDayIndex,
		})
		rolloverCtx, rolloverCancel := context.WithTimeout(ctx, 5*time.Second)
		defer rolloverCancel()
		if _, sentimentErr := sentimentService.EnsureSession(rolloverCtx, current.InstanceID); sentimentErr != nil {
			logger.Error("Sentiment session rollover failed", map[string]interface{}{
				"session_instance_id": current.InstanceID.String(),
				"error":               sentimentErr.Error(),
			})
		}

		// Cleanup old logs (Task 4.1)
		if _, err := decisionPipeline.CleanupOldLogs(rolloverCtx); err != nil {
			logger.Error("Failed to cleanup old decision logs", map[string]interface{}{"error": err.Error()})
		}
	})

	// Wire initial session instance from BEI snapshot
	if si := beiClient.GetSessionInstance(); si != nil {
		sessMonitor.UpdateInstance(convertBEISession(si))
		initial := sessMonitor.GetInstance()
		if initial != nil {
			if _, sentimentErr := sentimentService.EnsureSession(ctx, initial.InstanceID); sentimentErr != nil {
				log.Fatalf("Unable to initialize sentiment session: %v", sentimentErr)
			}
		}
	}
	if snapshot, snapshotOK := beiClient.Snapshot(); snapshotOK {
		if eventErr := syncPublicAnnouncements(eventStore, sessMonitor, snapshot); eventErr != nil {
			log.Fatalf("Unable to initialize public announcement context: %v", eventErr)
		}
	}

	// Task 3.3 risk runtime. Evaluation uses only reconciled account state and
	// public market snapshots; persistence is optimistic and bankruptcy terminal.
	riskRepo := risk.NewPostgresRepository(ctx, dbPool)
	riskEngine := risk.NewEngine(riskRepo, sched.Snapshots)
	riskStates := make(map[string]risk.State, len(registeredBots))
	for _, bot := range registeredBots {
		state, loadErr := riskRepo.Load(bot.BotID)
		if loadErr == nil {
			riskStates[bot.BotID] = state
		} else if errors.Is(loadErr, pgx.ErrNoRows) {
			riskStates[bot.BotID] = risk.State{BotID: bot.BotID, AccountID: bot.AccountID, Status: risk.StatusActive}
		} else {
			log.Fatalf("Unable to load risk state for %s: %v", bot.BotID, loadErr)
		}
	}
	var liquidationSequence atomic.Uint64
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		submittedLiquidations := make(map[string]struct{})
		limitsConfig := config.DefaultRiskConfig()
		limits := risk.Limits{
			MaxSymbolExposurePct: limitsConfig.MaxSymbolExposurePct,
			MaxDailyLossPct:      limitsConfig.MaxDailyLossPct,
			MaxWeeklyLossPct:     limitsConfig.MaxWeeklyLossPct,
			MaxInventoryShares:   limitsConfig.MaxInventoryShares,
			MaxLiquidationShares: limitsConfig.MaxLiquidationShares,
		}
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if !genesisCompleted || breakerMgr.GetState() != circuitbreaker.StateReady {
					continue
				}
				instance := sessMonitor.GetInstance()
				if instance == nil {
					continue
				}
				for _, bot := range registeredBots {
					account, exists := portfolioStore.Account(bot.AccountID)
					if !exists {
						continue
					}
					assessment, assessErr := riskEngine.Evaluate(
						riskStates[bot.BotID], account, limits,
						instance.InstanceID.String(), instance.VirtualDayIndex,
					)
					if assessErr != nil {
						logger.Error("Risk evaluation failed", map[string]interface{}{"bot_id": bot.BotID, "error": assessErr.Error()})
						sessionID := instance.InstanceID
						dayIndex := int64(instance.VirtualDayIndex)
						recordDecision(decision.DecisionLog{
							InternalID: &bot.InternalID, SessionInstanceID: &sessionID,
							VirtualDayIndex: &dayIndex, Strategy: "risk", Action: decision.ActionRiskHalt,
							DecisionReason:  "risk_evaluation_failed",
							ContextSnapshot: map[string]interface{}{"error": assessErr.Error()},
						})
						continue
					}
					riskStates[bot.BotID] = assessment.State
					if assessment.Changed && assessment.State.Status != risk.StatusActive {
						sessionID := instance.InstanceID
						dayIndex := int64(instance.VirtualDayIndex)
						recordDecision(decision.DecisionLog{
							InternalID: &bot.InternalID, SessionInstanceID: &sessionID,
							VirtualDayIndex: &dayIndex, Strategy: "risk", Action: decision.ActionRiskHalt,
							DecisionReason: assessment.State.DisabledReason,
							ContextSnapshot: map[string]interface{}{
								"status": assessment.State.Status, "equity_idr": assessment.EquityIDR,
								"daily_loss_idr": assessment.DailyLossIDR, "weekly_loss_idr": assessment.WeeklyLossIDR,
							},
						})
					}
					for _, liquidation := range assessment.LiquidationOrders {
						submissionKey := fmt.Sprintf("%s:%s:%s:%d", bot.BotID, instance.InstanceID, liquidation.Symbol, assessment.State.Version)
						if _, submitted := submittedLiquidations[submissionKey]; submitted {
							continue
						}
						sequence := liquidationSequence.Add(1)
						clientOrderID := fmt.Sprintf("bot:%s:%s:%d", bot.BotID, instance.InstanceID.String(), sequence)
						quantity := liquidation.QuantityShares
						if submitErr := orderQ.Submit(&queue.OrderRequest{
							ClientOrderID: clientOrderID, BotID: bot.BotID,
							Priority:  queue.PriorityRiskCancel,
							Payload:   liquidationPayload{AccountID: bot.AccountID, Symbol: liquidation.Symbol, Quantity: liquidation.QuantityShares},
							ExpiresAt: time.Now().Add(15 * time.Second),
						}); submitErr == nil {
							submittedLiquidations[submissionKey] = struct{}{}
							sessionID := instance.InstanceID
							dayIndex := int64(instance.VirtualDayIndex)
							recordDecision(decision.DecisionLog{
								InternalID: &bot.InternalID, SessionInstanceID: &sessionID,
								VirtualDayIndex: &dayIndex, Strategy: "risk", Symbol: liquidation.Symbol,
								Action: decision.ActionPlaceOrder, DecisionReason: "forced_liquidation",
								ClientOrderID: &clientOrderID, OrderQuantity: &quantity,
								ContextSnapshot: map[string]interface{}{"queue_priority": "risk_cancel"},
							})
						} else {
							reason := submitErr.Error()
							recordDecision(decision.DecisionLog{
								InternalID: &bot.InternalID, Strategy: "risk", Symbol: liquidation.Symbol,
								Action: decision.ActionReject, DecisionReason: "queue_rejected",
								ClientOrderID: &clientOrderID, RejectReason: &reason,
							})
						}
					}
				}
			}
		}
	}()

	// ── Background: Runtime + DB Pool Metrics (Task 1.8)
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				metrics.CollectRuntimeMetrics()
				metrics.CollectDBPoolMetrics(dbPool) // Task 1.8: DB pool active/idle
			}
		}
	}()

	// ── Background: Dependency Stale Monitoring (Task 1.7 — dependency stale breaker)
	// Uses per-endpoint freshness checks from BEI client (Task 2.4):
	//   - IsSessionStale() → global submission pause (most critical)
	//   - IsRulesStale() / IsFeesStale() → fail-closed for new orders
	//   - IsMDXStale() → only disable Index Tracker (Fase 5)
	go func() {
		ticker := time.NewTicker(250 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				beiSessionStale := beiClient.IsSessionStale()
				beiRulesStale := beiClient.IsRulesStale()
				beiFeesStale := beiClient.IsFeesStale()
				beiCriticalStale := beiSessionStale || beiRulesStale || beiFeesStale

				matsReady := matsClient.IsReady()
				streamConnected := sekuritasClient.StreamConnected()

				// Update dependency stale state in breaker
				if beiCriticalStale {
					markDependencyStale("bei", "bei_snapshot_stale")
				} else {
					breakerMgr.MarkDependencyFresh("bei")
				}
				if !matsReady {
					markDependencyStale("mats_ws", "market_stream_stale")
				} else {
					breakerMgr.MarkDependencyFresh("mats_ws")
				}
				if !streamConnected {
					markDependencyStale("account_stream", "account_stream_stale")
				} else {
					breakerMgr.MarkDependencyFresh("account_stream")
				}

				// Transition to ready only when ALL conditions are met:
				//   1. All dependencies fresh
				//   2. Kill switch not active
				//   3. Genesis completed (Task 2.2)
				allDepsReady := !beiCriticalStale && matsReady && streamConnected
				if allDepsReady && !breakerMgr.IsKillSwitchActive() && genesisCompleted {
					breakerMgr.SetState(circuitbreaker.StateReady)
				}
			}
		}
	}()

	// ── HTTP Router
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)

	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		state := breakerMgr.GetState()
		status := http.StatusOK
		if state == circuitbreaker.StateHalted || state == circuitbreaker.StateDegraded {
			status = http.StatusServiceUnavailable
		}
		w.WriteHeader(status)
		w.Write([]byte(fmt.Sprintf(`{"status":"%s"}`, state)))
	})

	r.Get("/readiness", func(w http.ResponseWriter, r *http.Request) {
		state := breakerMgr.GetState()
		anyStale := breakerMgr.AnyStaleDependency()
		genesisOK := genesisCompleted
		if state == circuitbreaker.StateReady && !anyStale && genesisOK {
			w.WriteHeader(http.StatusOK)
		} else {
			w.WriteHeader(http.StatusServiceUnavailable)
		}
		w.Write([]byte(fmt.Sprintf(
			`{"state":"%s","any_stale_dependency":%v,"genesis_completed":%v}`,
			state, anyStale, genesisOK,
		)))
	})

	// ── Start HTTP Server
	srv := &http.Server{
		Addr:    cfg.HTTPAddr,
		Handler: r,
	}
	go func() {
		logger.Info("API Server running", map[string]interface{}{"addr": cfg.HTTPAddr})
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("listen: %s\n", err)
		}
	}()

	// ── Start Subsystems
	go sched.Run(ctx)
	go reconciler.Run(ctx)
	go streamConsumer.Run(ctx)

	// BEI periodic refresh — also wires session monitor (Task 2.8)
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				refreshCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
				fetchErr := beiClient.FetchData(refreshCtx)
				cancel()
				if fetchErr != nil {
					logger.Error("BEI discovery refresh failed", map[string]interface{}{"error": fetchErr.Error()})
				} else {
					fresh, snapshotOK := beiClient.Snapshot()
					if !snapshotOK {
						markDependencyStale("bei", "bei_refresh_failed")
						continue
					}
					resolver, resolveErr := marketrules.NewSnapshotResolver(
						fresh.Securities, fresh.Rules, fresh.Fees, fresh.RulesAt,
					)
					if resolveErr != nil {
						markDependencyStale("bei", "bei_rules_invalid")
						logger.Error("BEI active rule snapshot invalid", map[string]interface{}{"error": resolveErr.Error()})
						continue
					}
					for _, symbol := range symbols {
						price, priceOK := resolver.LastPriceIDR(symbol)
						lot, lotOK := resolver.LotSize(symbol)
						if priceOK && lotOK {
							sched.Snapshots.Publish(scheduler.MarketSnapshot{
								Symbol: symbol, Price: price, LotSize: lot,
								RulesVersion: fresh.RulesAt.UTC().Format(time.RFC3339Nano),
								LastUpdate:   fresh.SecuritiesAt,
							})
						}
					}
					ruleStore.Update(resolver)
					// Task 2.8: Update session monitor from freshly-fetched BEI session instance.
					// BEI is the session authority; session monitor uses it as daily boundary.
					if si := beiClient.GetSessionInstance(); si != nil {
						sessMonitor.UpdateInstance(convertBEISession(si))
						current := sessMonitor.GetInstance()
						if current != nil {
							sentimentCtx, sentimentCancel := context.WithTimeout(ctx, 5*time.Second)
							_, sentimentErr := sentimentService.EnsureSession(sentimentCtx, current.InstanceID)
							sentimentCancel()
							if sentimentErr != nil {
								logger.Error("Sentiment session sync failed", map[string]interface{}{
									"session_instance_id": current.InstanceID.String(),
									"error":               sentimentErr.Error(),
								})
							}
						}
					}
					if eventErr := syncPublicAnnouncements(eventStore, sessMonitor, fresh); eventErr != nil {
						logger.Error("Public announcement context sync failed", map[string]interface{}{
							"error": eventErr.Error(),
						})
					}
				}
			}
		}
	}()

	// MATS WebSocket connection (reconnects automatically)
	go func() {
		if err := matsClient.Connect(ctx); err != nil {
			logger.Error("MATS WS connection ended", map[string]interface{}{"error": err.Error()})
		}
	}()

	// Order queue worker
	orderQ.Run(ctx, func(c context.Context, req *queue.OrderRequest) {
		internalID := internalIDByBotID[req.BotID]

		switch payload := req.Payload.(type) {
		case liquidationPayload:
			response, submitErr := sekuritasClient.PlaceOrder(c, payload.AccountID, sekuritas.PlaceOrderRequest{
				ClientOrderID: req.ClientOrderID,
				Symbol:        payload.Symbol, Side: "sell", OrderType: "market",
				Quantity: payload.Quantity,
			})
			if submitErr != nil {
				logger.Error("Liquidation order submission requires reconciliation", map[string]interface{}{
					"bot_id": req.BotID, "client_order_id": req.ClientOrderID, "error": submitErr.Error(),
				})
				reason := submitErr.Error()
				recordDecision(decision.DecisionLog{
					InternalID: optionalUUID(internalID), Strategy: "risk", Symbol: payload.Symbol,
					Action: decision.ActionReject, DecisionReason: "sekuritas_submit_failed",
					ClientOrderID: &req.ClientOrderID, RejectReason: &reason,
					OrderQuantity: &payload.Quantity,
				})
			} else {
				recordDecision(decision.DecisionLog{
					InternalID: optionalUUID(internalID), Strategy: "risk", Symbol: payload.Symbol,
					Action: decision.ActionPlaceOrder, DecisionReason: "sekuritas_accepted",
					ClientOrderID: &req.ClientOrderID, SekuritasOrderID: &response.ID,
					OrderQuantity: &payload.Quantity, OrderSubmitted: true, OrderStatus: &response.Status,
				})
			}

		case queue.SubmitOrderPayload:
			response, submitErr := sekuritasClient.PlaceOrder(c, payload.AccountID, sekuritas.PlaceOrderRequest{
				ClientOrderID: req.ClientOrderID,
				Symbol:        payload.Symbol, Side: payload.Side, OrderType: "limit",
				PriceIDR: payload.PriceIDR, Quantity: payload.Quantity,
			})
			if submitErr != nil {
				nextStatus := portfolio.StatusRejected
				if errors.Is(submitErr, sekuritas.ErrOrderSubmitUnknown) {
					nextStatus = portfolio.StatusSubmitUnknown
				}
				_ = portfolioStore.UpdateLocalOrderStatus(req.ClientOrderID, nextStatus)
				logger.Error("Normal order submission failed", map[string]interface{}{
					"bot_id": req.BotID, "client_order_id": req.ClientOrderID, "error": submitErr.Error(),
				})
				reason := submitErr.Error()
				recordDecision(decision.DecisionLog{
					InternalID: optionalUUID(internalID), Strategy: "noise_trader", Symbol: payload.Symbol,
					Action: decision.ActionReject, DecisionReason: "sekuritas_submit_failed",
					ClientOrderID: &req.ClientOrderID, RejectReason: &reason,
					OrderQuantity: &payload.Quantity,
				})
			} else {
				_ = portfolioStore.SetLocalOrderID(req.ClientOrderID, response.ID)
				_ = portfolioStore.UpdateLocalOrderStatus(req.ClientOrderID, portfolio.StatusOpen)
				recordDecision(decision.DecisionLog{
					InternalID: optionalUUID(internalID), Strategy: "noise_trader", Symbol: payload.Symbol,
					Action: decision.ActionPlaceOrder, DecisionReason: "sekuritas_accepted",
					ClientOrderID: &req.ClientOrderID, SekuritasOrderID: &response.ID,
					OrderQuantity: &payload.Quantity, OrderSubmitted: true, OrderStatus: &response.Status,
				})
			}

		case queue.CancelOrderPayload:
			// Fetch the sekuritas order ID first
			orderMeta, fetchErr := sekuritasClient.GetOrderByClientID(c, payload.AccountID, payload.ClientOrderID)
			if fetchErr != nil {
				logger.Error("Cancel order lookup failed", map[string]interface{}{
					"bot_id": req.BotID, "client_order_id": payload.ClientOrderID, "error": fetchErr.Error(),
				})
				reason := fetchErr.Error()
				recordDecision(decision.DecisionLog{
					InternalID: optionalUUID(internalID), Strategy: "noise_trader",
					Action: decision.ActionReject, DecisionReason: "sekuritas_cancel_lookup_failed",
					ClientOrderID: &payload.ClientOrderID, RejectReason: &reason,
				})
				return
			}

			cancelErr := sekuritasClient.CancelOrder(c, payload.AccountID, orderMeta.ID)
			if cancelErr != nil {
				logger.Error("Cancel order failed", map[string]interface{}{
					"bot_id": req.BotID, "order_id": orderMeta.ID, "error": cancelErr.Error(),
				})
				reason := cancelErr.Error()
				recordDecision(decision.DecisionLog{
					InternalID: optionalUUID(internalID), Strategy: "noise_trader",
					Action: decision.ActionReject, DecisionReason: "sekuritas_cancel_failed",
					ClientOrderID: &payload.ClientOrderID, RejectReason: &reason,
					SekuritasOrderID: &orderMeta.ID,
				})
			} else {
				recordDecision(decision.DecisionLog{
					InternalID: optionalUUID(internalID), Strategy: "noise_trader",
					Action: decision.ActionCancel, DecisionReason: "sekuritas_cancel_accepted",
					ClientOrderID: &payload.ClientOrderID, SekuritasOrderID: &orderMeta.ID,
					OrderSubmitted: true,
				})
			}

		default:
			logger.Warn("Unknown payload type in order queue", map[string]interface{}{
				"bot_id": req.BotID, "client_order_id": req.ClientOrderID,
			})
		}
	})

	// ── Initialize Autonomous Strategies (Task 4.2)
	// realism.Engine is constructed with a session-independent fallback seed here;
	// the per-bot per-session HMAC seed is derived inside HandleTask using sessionSeeder.
	realismEngine := realism.New(time.Now().UnixNano())
	accountLookup := func(botID string) string {
		for _, b := range registeredBots {
			if b.BotID == botID {
				return b.AccountID
			}
		}
		return ""
	}
	internalIDLookup := func(botID string) *uuid.UUID {
		id, ok := internalIDByBotID[botID]
		if !ok {
			return nil
		}
		return &id
	}

	noiseTrader := noise.NewTrader(
		configMgr, portfolioStore, sched, realismEngine, sessMonitor, orderQ, ruleStore,
		accountLookup, internalIDLookup, sessionSeeder, decisionPipeline,
	)

	// Bootstrap registered bots that are noise_traders
	for _, bot := range registeredBots {
		cfg, _, err := configMgr.GetDBConfig(ctx, bot.BotID)
		if err == nil && cfg.StrategyType == "noise_trader" {
			// Stagger startup across 1–5 s to avoid thundering-herd on order queue.
			delay := time.Duration(1+time.Now().UnixNano()%4) * time.Second
			sched.Schedule(&scheduler.Task{
				BotID:     bot.BotID,
				ExecuteAt: time.Now().Add(delay),
				Handler:   noiseTrader.HandleTask,
			})
			logger.Info("Bootstrapped Noise Trader bot", map[string]interface{}{"bot_id": bot.BotID})
		}
	}

	// ── Graceful Shutdown (BOT_STATE_MACHINES.md §15)
	// Default shutdown does NOT cancel all market orders.
	// Use explicit pause-and-cancel or kill switch to cancel orders first.
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	logger.Info("Shutting down BOT Service...", nil)
	cancel() // Signal all background goroutines to stop

	ctxShutdown, cancelShutdown := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelShutdown()
	if err := strategyStateMgr.Flush(ctxShutdown); err != nil {
		logger.Error("Strategy state shutdown flush failed", map[string]interface{}{"error": err.Error()})
	}
	if err := decisionPipeline.CloseContext(ctxShutdown); err != nil {
		logger.Error("Decision log shutdown flush failed", map[string]interface{}{"error": err.Error()})
	}
	if err := srv.Shutdown(ctxShutdown); err != nil {
		log.Fatalf("Server Shutdown Failed:%+v", err)
	}
	logger.Info("BOT Service gracefully stopped", nil)
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// checkGenesisCompleted queries the genesis_runs table to determine whether
// a completed genesis exists.
//
// Per Task 2.2:
//   - If bots are registered AND no completed genesis: log warning, return false.
//   - If no bots are registered (fresh install): return true (genesis not yet required).
//   - If completed genesis exists: return true.
//
// Returns false (not completed) only when bots are registered without a completed genesis.
func checkGenesisCompleted(ctx context.Context, db *pgxpool.Pool, botCount int) bool {
	var count int
	err := db.QueryRow(ctx, `SELECT COUNT(*) FROM genesis_runs WHERE status = 'completed'`).Scan(&count)
	if err != nil {
		logger.Warn("Unable to check genesis_runs status; assuming genesis not completed", map[string]interface{}{
			"error": err.Error(),
		})
		if botCount > 0 {
			return false
		}
		return true // fresh install, genesis not yet required
	}

	if count > 0 {
		logger.Info("Genesis completed — portfolio seed verified", map[string]interface{}{
			"completed_runs": count,
		})
		return true
	}

	if botCount > 0 {
		logger.Warn("No completed genesis found but bots are registered. "+
			"Run `./provision genesis` to seed initial portfolios. "+
			"Service will start but will NOT transition to ready until genesis is completed.",
			map[string]interface{}{"registered_bots": botCount})
		return false
	}

	// Fresh install: no bots, no genesis — that's OK
	logger.Info("Fresh install detected: no bots registered and no genesis yet", nil)
	return true
}

// convertBEISession converts a bei.SessionInstance to a session.SessionInstance
// for use by the session Monitor. The two types mirror the same BEI contract
// (BOT_API_CONTRACTS.md §10) but live in separate packages to avoid import cycles.
func convertBEISession(s *beiClient.SessionInstance) *session.SessionInstance {
	if s == nil {
		return nil
	}
	return &session.SessionInstance{
		InstanceID:          s.InstanceID,
		VirtualDayIndex:     s.VirtualDayIndex,
		VirtualDurationSecs: s.VirtualDurationSecs,
		RealDurationSecs:    s.RealDurationSecs,
		RealTimeRemainSecs:  s.RealTimeRemainSecs,
		Status:              session.SessionState(s.Status),
		StartedAt:           s.StartedAt,
		ExpectedEndAt:       s.ExpectedEndAt,
		Version:             s.Version,
	}
}

func updateMarketPrice(store *scheduler.SnapshotStore, event mats.Event) {
	if event.Symbol == "" || len(event.Payload) == 0 {
		return
	}
	var payload map[string]interface{}
	decoder := json.NewDecoder(strings.NewReader(string(event.Payload)))
	decoder.UseNumber()
	if decoder.Decode(&payload) != nil {
		return
	}
	var price int64
	for _, key := range []string{"last_price", "last", "price"} {
		value, exists := payload[key]
		if !exists {
			continue
		}
		parsed, err := strconv.ParseInt(fmt.Sprint(value), 10, 64)
		if err == nil && parsed > 0 {
			price = parsed
			break
		}
	}
	if price == 0 {
		return
	}
	current, ok := store.Get(event.Symbol)
	if !ok || current.LotSize <= 0 {
		return // fail closed until BEI rules are available
	}
	current.Price = price
	current.LastUpdate = event.OccurredAt
	if current.LastUpdate.IsZero() {
		current.LastUpdate = time.Now().UTC()
	}
	store.Publish(current)
}

func syncPublicAnnouncements(store *eventcontext.Store, monitor *session.Monitor, snapshot beiClient.Snapshot) error {
	if store == nil || monitor == nil || len(snapshot.Announcements) == 0 {
		return nil
	}
	// Strategy spec minimum_publication_age_virtual_seconds defaults to one.
	minimumAge := monitor.VirtualToRealDelay(time.Second)
	_, err := store.IngestBEISnapshot(snapshot.Announcements, snapshot.AnnouncementsAt, minimumAge)
	return err
}
