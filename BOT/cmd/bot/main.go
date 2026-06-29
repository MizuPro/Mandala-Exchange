package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Mandala-Exchange/BOT/internal/circuitbreaker"
	"github.com/Mandala-Exchange/BOT/internal/client/bei"
	"github.com/Mandala-Exchange/BOT/internal/client/mats"
	"github.com/Mandala-Exchange/BOT/internal/client/sekuritas"
	"github.com/Mandala-Exchange/BOT/internal/config"
	"github.com/Mandala-Exchange/BOT/internal/logger"
	"github.com/Mandala-Exchange/BOT/internal/metrics"
	"github.com/Mandala-Exchange/BOT/internal/portfolio"
	"github.com/Mandala-Exchange/BOT/internal/queue"
	"github.com/Mandala-Exchange/BOT/internal/reconciliation"
	"github.com/Mandala-Exchange/BOT/internal/scheduler"
	"github.com/Mandala-Exchange/BOT/internal/session"
)

func main() {
	// Initialize Config
	cfg, err := config.LoadEnv()
	if err != nil {
		log.Fatal(err)
	}

	logger.Info("Starting BOT Service", map[string]interface{}{
		"env":  cfg.AppEnv,
		"port": cfg.HTTPAddr,
	})

	// Setup Database Connection Pool
	dbConfig, err := pgxpool.ParseConfig(cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("Unable to parse database url: %v", err)
	}
	dbConfig.MaxConns = 15 // Task 1.5/1.8: DB connection pool maksimum default 15.

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	dbPool, err := pgxpool.NewWithConfig(ctx, dbConfig)
	if err != nil {
		log.Fatalf("Unable to create connection pool: %v", err)
	}
	defer dbPool.Close()

	if err := dbPool.Ping(ctx); err != nil {
		log.Fatalf("Unable to connect to database: %v", err)
	}

	// Initialize Components
	configMgr := config.NewConfigManager(dbPool)
	_ = configMgr // Will be used to reconcile config

	breakerMgr := circuitbreaker.NewBreakerManager()
	breakerMgr.SetState(circuitbreaker.StateSyncing)

	sched := scheduler.NewScheduler(8) // 4-8 workers

	orderQ := queue.NewOrderQueue(10, 5000)

	// Initialize Clients (Phase 2)
	sekuritasClient := sekuritas.NewClient(cfg.SekuritasBaseURL, cfg.ServiceToken)
	matsClient := mats.NewClient(cfg.MatsWSURL, cfg.ServiceToken)
	beiClient := bei.NewClient(cfg.BeiBaseURL, cfg.ServiceToken)
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
	matsClient.Configure(symbols, nil)

	portfolioStore := portfolio.NewStore()
	rows, err := dbPool.Query(ctx, `SELECT sekuritas_account_id::text FROM bots WHERE sekuritas_account_id IS NOT NULL AND status NOT IN ('disabled','bankrupt')`)
	if err != nil {
		log.Fatalf("Unable to load BOT account registry: %v", err)
	}
	var accountIDs []string
	for rows.Next() {
		var accountID string
		if err := rows.Scan(&accountID); err != nil {
			rows.Close()
			log.Fatalf("Unable to scan BOT account registry: %v", err)
		}
		accountIDs = append(accountIDs, accountID)
	}
	rows.Close()
	if len(accountIDs) > 0 {
		tokenCtx, tokenCancel := context.WithTimeout(ctx, 10*time.Second)
		err = sekuritasClient.FetchTokens(tokenCtx, accountIDs, "startup-token-batch-"+time.Now().UTC().Format("200601021504"))
		tokenCancel()
		if err != nil {
			log.Fatalf("Unable to issue BOT JWT batch: %v", err)
		}
	}
	reconciler := reconciliation.NewReconciler(sekuritasClient, portfolioStore, accountIDs, 60*time.Second)
	streamConsumer := reconciliation.NewStreamConsumer(sekuritasClient, portfolioStore, reconciler)
	sessMonitor := session.NewMonitor()
	_ = beiClient
	_ = sessMonitor

	// Setup background metrics collection
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				metrics.CollectRuntimeMetrics()
			}
		}
	}()

	// Setup Router
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

	// Start API Server
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

	// Start Subsystems
	go sched.Run(ctx)
	go reconciler.Run(ctx)
	go streamConsumer.Run(ctx)
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				refreshCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
				err := beiClient.FetchData(refreshCtx)
				cancel()
				if err != nil {
					logger.Error("BEI discovery refresh failed", map[string]interface{}{"error": err.Error()})
				}
			}
		}
	}()
	go func() {
		if err := matsClient.Connect(ctx); err != nil {
			logger.Error("Failed to connect to MATS WS", map[string]interface{}{"error": err.Error()})
		}
	}()
	go func() {
		ticker := time.NewTicker(250 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if beiClient.IsStale() || !matsClient.IsReady() || !sekuritasClient.StreamConnected() {
					breakerMgr.SetState(circuitbreaker.StateSyncing)
					continue
				}
				breakerMgr.SetState(circuitbreaker.StateReady)
			}
		}
	}()

	orderQ.Run(ctx, func(c context.Context, req *queue.OrderRequest) {
		// Mock order processing
		logger.Info("Processing order", map[string]interface{}{
			"bot_id":          req.BotID,
			"client_order_id": req.ClientOrderID,
		})
	})

	// Wait for interrupt signal to gracefully shutdown
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	logger.Info("Shutting down BOT Service...", nil)
	cancel() // signal background goroutines to stop

	ctxShutdown, cancelShutdown := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelShutdown()
	if err := srv.Shutdown(ctxShutdown); err != nil {
		log.Fatalf("Server Shutdown Failed:%+v", err)
	}
	logger.Info("BOT Service gracefully stopped", nil)
}
