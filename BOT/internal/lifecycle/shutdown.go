package lifecycle

import (
	"context"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Mandala-Exchange/bot-v2/internal/admin"
	"github.com/Mandala-Exchange/bot-v2/internal/client/mats"
	"github.com/Mandala-Exchange/bot-v2/internal/logger"
	"github.com/Mandala-Exchange/bot-v2/internal/queue"
)

func WaitForShutdown(ctx context.Context, cancel context.CancelFunc, adminServer *admin.Server, matsClient *mats.Client, ordQueue *queue.OrderQueue) {
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	select {
	case sig := <-sigChan:
		logger.Warn("Shutdown signal received", "signal", sig.String())
	case <-ctx.Done():
		logger.Warn("Shutdown triggered programmatically")
	}

	// Start graceful shutdown
	logger.Info("Starting graceful shutdown sequence...")

	// 1. Cancel main context (stops scheduler, refeshers, etc)
	cancel()

	// 2. Stop HTTP Server (no new HTTP requests)
	shutdownCtx, serverCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer serverCancel()
	if err := adminServer.Stop(shutdownCtx); err != nil {
		logger.Error("Failed to stop Admin HTTP Server cleanly", "error", err.Error())
	}

	// 3. Stop MATS WS
	matsClient.Stop()

	// 4. Close queue channel so executor worker loop knows it should drain
	ordQueue.Close()

	// 5. Allow some time to drain existing items in queue (we wait 5 seconds max in skeleton)
	logger.Info("Waiting for queue executor to finish processing current items...")
	time.Sleep(3 * time.Second)

	logger.Info("Graceful shutdown completed. Exiting.")
}
