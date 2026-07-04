package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"os"
	"time"

	"github.com/Mandala-Exchange/bot-v2/internal/admin"
	"github.com/Mandala-Exchange/bot-v2/internal/client/bei"
	"github.com/Mandala-Exchange/bot-v2/internal/client/mats"
	"github.com/Mandala-Exchange/bot-v2/internal/client/sekuritas"
	"github.com/Mandala-Exchange/bot-v2/internal/config"
	"github.com/Mandala-Exchange/bot-v2/internal/executor"
	"github.com/Mandala-Exchange/bot-v2/internal/lifecycle"
	"github.com/Mandala-Exchange/bot-v2/internal/logger"
	"github.com/Mandala-Exchange/bot-v2/internal/metrics"
	"github.com/Mandala-Exchange/bot-v2/internal/population"
	"github.com/Mandala-Exchange/bot-v2/internal/portfolio"
	"github.com/Mandala-Exchange/bot-v2/internal/queue"
	"github.com/Mandala-Exchange/bot-v2/internal/registry"
	"github.com/Mandala-Exchange/bot-v2/internal/runner"
	"github.com/Mandala-Exchange/bot-v2/internal/scheduler"
	"github.com/Mandala-Exchange/bot-v2/internal/strategy"
	"github.com/Mandala-Exchange/bot-v2/internal/strategy/noise"
	"github.com/google/uuid"
)

func main() {
	configPath := flag.String("config", "configs/config.yaml", "Path to config file")
	flag.Parse()

	// 1. Init logger
	logger.Init()
	logger.Info("Starting BOT-v2 Skeleton Service")

	// 2. Load Config
	cfg, err := config.LoadConfig(*configPath)
	if err != nil {
		logger.Error("Failed to load config", "error", err.Error())
		os.Exit(1)
	}
	if cfg.Population.Enabled {
		generatedBots, err := population.Generate(cfg.Population)
		if err != nil {
			logger.Error("Failed to generate bot population", "error", err.Error())
			os.Exit(1)
		}
		cfg.Bots = generatedBots
		logger.Info("Generated deterministic bot population",
			"size", len(cfg.Bots),
			"seed", cfg.Population.Seed,
		)
	}

	mainCtx, mainCancel := context.WithCancel(context.Background())
	defer mainCancel()

	// 3. Init clients
	beiClient := bei.NewClient(cfg.BEI.BaseURL, cfg.BEI.ServiceToken)
	matsClient := mats.NewClient(cfg.MATS.WSURL, cfg.MATS.ServiceToken, cfg.MATS.Symbols)
	sekuritasClient := sekuritas.NewClient(cfg.Sekuritas.BaseURL, cfg.Sekuritas.ServiceToken)
	reg := registry.NewRegistry()
	sessionMetrics := metrics.NewManager()

	// 4. Initial fast/slow poll of BEI state
	logger.Info("Performing initial BEI data sync...")
	if _, err := beiClient.PollSessionState(mainCtx); err != nil {
		logger.Error("Initial session state poll failed", "error", err.Error())
		os.Exit(1)
	}
	if err := beiClient.PollAllState(mainCtx); err != nil {
		logger.Error("Initial reference data poll failed", "error", err.Error())
		os.Exit(1)
	}
	logger.Info("Initial BEI data sync completed successfully")

	// 5. Bot Provisioning (Sekuritas)
	logger.Info("Provisioning bots on Sekuritas...")
	provisionReq := sekuritas.ProvisionBatchRequest{
		Bots: make([]sekuritas.ProvisionBotRequest, 0, len(cfg.Bots)),
	}
	for _, b := range cfg.Bots {
		provisionReq.Bots = append(provisionReq.Bots, sekuritas.ProvisionBotRequest{
			ExternalBotID:  b.ExternalBotID,
			Email:          b.Email,
			DisplayName:    b.ExternalBotID,
			Tier:           b.Tier,
			Strategy:       b.Strategy,
			InitialCashIDR: b.InitialCash,
		})
	}

	provisionHashBytes, _ := json.Marshal(provisionReq)
	provisionHash := sha256.Sum256(provisionHashBytes)
	provisionIdemKey := "provision-" + hex.EncodeToString(provisionHash[:16])

	provisionResp, err := sekuritasClient.ProvisionBots(mainCtx, provisionReq, provisionIdemKey)
	if err != nil {
		logger.Error("Failed to provision bots", "error", err.Error())
		os.Exit(1)
	}

	accountIDs := make([]string, 0, len(provisionResp.Results))
	genesisAccounts := make([]map[string]interface{}, 0, len(provisionResp.Results))
	botConfigs := make(map[string]config.BotConfig, len(cfg.Bots))
	for _, botConfig := range cfg.Bots {
		botConfigs[botConfig.ExternalBotID] = botConfig
	}

	for _, res := range provisionResp.Results {
		if res.Error != nil && *res.Error != "" {
			logger.Error("Bot provisioning failed for instance", "bot_id", res.ExternalBotID, "error", *res.Error)
			continue
		}

		logger.Info("Bot provisioned successfully", "bot_id", res.ExternalBotID, "account_id", res.AccountID, "status", res.Status)

		// Register in local registry
		botConfig := botConfigs[res.ExternalBotID]
		strategy := botConfig.Strategy

		reg.Register(res.ExternalBotID, res.AccountID, strategy)
		accountIDs = append(accountIDs, res.AccountID)

		// Set initial cash from config
		initialCash := botConfig.InitialCash
		initialPositions := botConfig.InitialPositions
		if len(initialPositions) == 0 {
			initialPositions = []config.GenesisPosition{
				{Symbol: "BARA", Quantity: 1000, AveragePrice: 190},
				{Symbol: "NUSA", Quantity: 1000, AveragePrice: 735},
				{Symbol: "MNDL", Quantity: 1000, AveragePrice: 320},
			}
		}
		positionPayload := make([]map[string]interface{}, 0, len(initialPositions))
		for _, position := range initialPositions {
			positionPayload = append(positionPayload, map[string]interface{}{
				"symbol":            position.Symbol,
				"quantity_shares":   position.Quantity,
				"average_price_idr": position.AveragePrice,
			})
		}

		// Prepare genesis payload
		genesisAccounts = append(genesisAccounts, map[string]interface{}{
			"external_bot_id": res.ExternalBotID,
			"account_id":      res.AccountID,
			"cash_idr":        initialCash,
			"positions":       positionPayload,
		})
	}

	if len(accountIDs) == 0 {
		logger.Error("No bots successfully provisioned")
		os.Exit(1)
	}

	// 6. Fetch Tokens
	logger.Info("Fetching JWT tokens for provisioned bots...")
	tokenIdemKey := "tokens-" + uuid.NewString()
	if err := sekuritasClient.FetchTokens(mainCtx, accountIDs, tokenIdemKey); err != nil {
		logger.Error("Failed to fetch bot tokens", "error", err.Error())
		os.Exit(1)
	}
	logger.Info("Bot tokens fetched successfully")

	// 7. Trigger Genesis Seeding
	logger.Info("Triggering genesis on Sekuritas...")
	genesisRunID := uuid.New().String()
	genesisPayload := map[string]interface{}{
		"genesis_run_id": genesisRunID,
		"accounts":       genesisAccounts,
	}

	genesisHashBytes, _ := json.Marshal(genesisPayload)
	genesisHash := sha256.Sum256(genesisHashBytes)
	genesisIdemKey := "genesis-" + hex.EncodeToString(genesisHash[:16])

	if err := sekuritasClient.TriggerGenesis(mainCtx, genesisPayload, genesisIdemKey); err != nil {
		logger.Error("Failed to trigger genesis", "error", err.Error())
		// If genesis is already completed, it might return conflict/error, which is fine for local restarts.
		// So we log it but don't hard exit unless necessary.
		logger.Warn("Genesis seeding warning (might be already seeded)", "error", err.Error())
	} else {
		logger.Info("Genesis seeding completed successfully", "run_id", genesisRunID)
	}

	// 8. Bulk portfolio snapshot load
	logger.Info("Loading initial portfolio snapshots...")
	snap, err := sekuritasClient.BulkSnapshot(mainCtx, accountIDs)
	if err != nil {
		logger.Error("Failed to load initial portfolio snapshot", "error", err.Error())
		os.Exit(1)
	}
	for _, acc := range snap.Accounts {
		if b, ok := reg.GetBot(acc.AccountID); ok {
			b.UpdateFromSnapshot(acc)
		}
	}
	logger.Info("Portfolios loaded successfully from Sekuritas snapshot")
	eventStreamSequence := snap.AsOfSequence

	// 9. Start background clients
	matsClient.Start(mainCtx)

	// Start Token Refresher loop
	sekuritasClient.StartTokenRefresher(mainCtx, accountIDs)

	// Connect to Sekuritas Account Event Stream WebSocket
	go func() {
		lastSeq := eventStreamSequence
		for {
			select {
			case <-mainCtx.Done():
				return
			default:
			}

			logger.Info("Connecting to Sekuritas account event stream WS...")
			err := sekuritasClient.ConnectEventStream(mainCtx, lastSeq, func(ev portfolio.Event) error {
				lastSeq = ev.Sequence
				bot, ok := reg.GetBot(ev.AccountID)
				if !ok {
					return nil
				}

				logger.Info("Received account event",
					"type", ev.EventType,
					"account_id", ev.AccountID,
					"seq", ev.Sequence,
				)
				sessionID := ""
				if session := beiClient.GetSnapshot().Session; session != nil {
					sessionID = session.ID
				}
				sessionMetrics.RecordEvent(sessionID, bot.Strategy, ev.EventType)

				// Fase 3: update OpenOrderIDs lifecycle berdasarkan event type
				switch ev.EventType {
				case "order_accepted":
					var payload struct {
						ClientOrderID string `json:"client_order_id"`
						OrderID       string `json:"order_id"`
					}
					if err := json.Unmarshal(ev.Payload, &payload); err == nil &&
						payload.ClientOrderID != "" && payload.OrderID != "" {
						bot.SetOpenOrderID(payload.ClientOrderID, payload.OrderID)
					}

				case "order_filled", "order_cancelled", "order_rejected", "order_expired":
					var payload struct {
						ClientOrderID string `json:"client_order_id"`
					}
					if err := json.Unmarshal(ev.Payload, &payload); err == nil &&
						payload.ClientOrderID != "" {
						bot.DeleteOpenOrderID(payload.ClientOrderID)
					}
				}

				// Fat event: update portfolio langsung dari payload account
				var fatPayload struct {
					Account *portfolio.Account `json:"account"`
				}
				if err := json.Unmarshal(ev.Payload, &fatPayload); err == nil && fatPayload.Account != nil {
					bot.UpdateFromSnapshot(*fatPayload.Account)
					logger.Info("Updated bot portfolio from fat event", "bot_id", bot.ExternalBotID)
				}

				return nil
			})

			if err != nil {
				if mainCtx.Err() != nil {
					return
				}
				logger.Error("Sekuritas account event stream error, reconnecting in 5s...", "error", err.Error())
				select {
				case <-mainCtx.Done():
					return
				case <-time.After(5 * time.Second):
				}
			}
		}
	}()

	// 10. Start Order Queue dan Executor
	ordQueue := queue.NewOrderQueue(cfg.Queue.BufferSize, cfg.Queue.TTL)
	exec := executor.NewExecutor(beiClient, sekuritasClient, reg, ordQueue, cfg.Executor.OrdersPerMinute)
	exec.Start(mainCtx)

	// 11. Build Strategy Registry dan Runner
	strategyReg := strategy.NewStrategyRegistry()
	strategyReg.Register("noise_trader", noise.New(cfg.Strategy.NoiseTrader))
	logger.Info("Strategy registry built", "registered", []string{"noise_trader"})

	botRunner := runner.New(reg, beiClient, matsClient, ordQueue, strategyReg)
	botRunner.SetMetrics(sessionMetrics)
	logger.Info("Strategy runner initialized")

	// 12. Start Scheduler (inject botRunner + strategy config)
	sched := scheduler.NewScheduler(
		beiClient,
		sekuritasClient,
		reg,
		botRunner,
		cfg.Scheduler,
		5*time.Second,
	)
	sched.Start(mainCtx)

	// 13. Start Admin HTTP Server
	adminServer := admin.NewServer(cfg.Admin.Port, beiClient, sekuritasClient, exec, mainCancel)
	adminServer.Start()

	logger.Info("BOT-v2 Service initialized successfully and running")

	// 13. Block for Graceful Shutdown
	lifecycle.WaitForShutdown(mainCtx, mainCancel, adminServer, matsClient, ordQueue)
}
