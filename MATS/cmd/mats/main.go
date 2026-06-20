package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/joho/godotenv"

	"mandala-exchange/mats/internal/api"
	"mandala-exchange/mats/internal/auth"
	"mandala-exchange/mats/internal/bei"
	"mandala-exchange/mats/internal/config"
	"mandala-exchange/mats/internal/events"
	"mandala-exchange/mats/internal/httpserver"
	"mandala-exchange/mats/internal/marketdata"
	"mandala-exchange/mats/internal/matching"
	"mandala-exchange/mats/internal/orders"
	"mandala-exchange/mats/internal/persistence"
	"mandala-exchange/mats/internal/rules"
	"mandala-exchange/mats/internal/sequence"
	"mandala-exchange/mats/internal/session"
)

func main() {
	if envFile := os.Getenv("MANDALA_ENV_FILE"); envFile != "" {
		_ = godotenv.Load(envFile)
	} else if appEnv := os.Getenv("APP_ENV"); appEnv != "" {
		_ = godotenv.Load(".env." + appEnv)
	} else {
		_ = godotenv.Load()
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(logger)

	cfg, err := config.Load()
	if err != nil {
		logger.Error("load config", "error", err)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	var store persistence.Store = persistence.NewMemoryStore()
	var seq sequence.Generator = sequence.NewAtomic(0)
	var poolCloser func()
	if cfg.DatabaseURL != "" {
		pool, err := persistence.Connect(ctx, cfg.DatabaseURL)
		if err != nil {
			logger.Error("connect postgres", "error", err)
			os.Exit(1)
		}
		store = persistence.NewPostgresStore(pool)
		seq = sequence.NewPostgres(pool)
		poolCloser = pool.Close
	}
	if poolCloser != nil {
		defer poolCloser()
	}

	beiClient := bei.NewClient(cfg.BEIBaseURL, cfg.BEIServiceToken)
	rulesCache := rules.NewCache(beiClient)
	if err := rulesCache.Refresh(ctx); err != nil {
		logger.Warn("initial BEI sync failed; order validation will reject until sync succeeds", "error", err)
	}
	summaries := marketdata.NewSummaryStore()
	// Gunakan session ID dari BEI jika sync berhasil, fallback ke cfg.SessionID
	initialSessionID := rulesCache.ActiveSessionID()
	if initialSessionID == "" {
		initialSessionID = cfg.SessionID
	}
	engine := matching.NewEngine(seq, initialSessionID, summaries)

	hub := marketdata.NewHub()
	hub.SetProviders(engine, rulesCache)
	dispatcher := events.NewDispatcher(store, seq, beiClient, hub, events.Config{
		SekuritasEventsURL:    cfg.SekuritasEventsURL,
		SekuritasServiceToken: cfg.SekuritasServiceToken,
		MaxAttempts:           cfg.DeliveryMaxAttempts,
	}, logger)
	go dispatcher.Start(ctx, time.Second)

	orderService := orders.NewService(engine, store, seq, rulesCache, orders.NewBEIBrokerValidator(beiClient))
	orderService.SetDispatcher(dispatcher)
	if err := orderService.Recover(ctx); err != nil {
		logger.Error("recover order book", "error", err)
		os.Exit(1)
	}
	if initialSessionID != "" {
		trades, err := store.LoadTradesBySession(ctx, initialSessionID)
		if err != nil {
			logger.Error("recover market summaries", "session_id", initialSessionID, "error", err)
			os.Exit(1)
		}
		summaries.Recover(trades)
		logger.Info("recovered market summaries", "session_id", initialSessionID, "trades", len(trades))
	}

	sessionController := session.NewController(rulesCache, orderService, dispatcher)
	sessionDaemon := session.NewDaemon(sessionController, logger)
	go sessionDaemon.Start(ctx)

	subscriber, err := rules.NewSubscriber(cfg.RedisURL, logger, rulesCache, engine, rules.Callbacks{
		OnSuspendSymbol: sessionController.SuspendSymbol,
		OnMarketHalt:    sessionController.HaltMarket,
	})
	if err != nil {
		logger.Error("failed to create redis subscriber", "error", err)
		os.Exit(1)
	}
	go subscriber.Start(ctx)
	defer subscriber.Close()

	handler := api.NewHandler(orderService, engine, rulesCache, store, sessionController, dispatcher)
	router := httpserver.NewRouter(handler, auth.New(cfg.ServiceTokens), hub)
	server := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           router,
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		logger.Info("starting MATS service", "addr", cfg.HTTPAddr)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Error("http server failed", "error", err)
			os.Exit(1)
		}
	}()

	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		logger.Error("http shutdown failed", "error", err)
	}
}
