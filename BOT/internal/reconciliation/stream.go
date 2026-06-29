package reconciliation

import (
	"context"
	"errors"
	"time"

	"github.com/Mandala-Exchange/BOT/internal/client/sekuritas"
	"github.com/Mandala-Exchange/BOT/internal/logger"
	"github.com/Mandala-Exchange/BOT/internal/portfolio"
)

type StreamConsumer struct {
	client     *sekuritas.Client
	store      *portfolio.Store
	reconciler *Reconciler
}

func NewStreamConsumer(client *sekuritas.Client, store *portfolio.Store, reconciler *Reconciler) *StreamConsumer {
	return &StreamConsumer{client: client, store: store, reconciler: reconciler}
}

func (c *StreamConsumer) Run(ctx context.Context) {
	backoff := 250 * time.Millisecond
	for ctx.Err() == nil {
		if err := c.reconciler.Recover(ctx); err != nil {
			logger.Error("account snapshot recovery failed", map[string]interface{}{"error": err.Error()})
		} else {
			err := c.client.ConnectEventStream(ctx, c.store.LastSequence(), c.store.Apply)
			if err != nil && !errors.Is(err, context.Canceled) {
				logger.Warn("account event stream interrupted", map[string]interface{}{"error": err.Error()})
			}
		}
		timer := time.NewTimer(backoff)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		if backoff < 8*time.Second {
			backoff *= 2
		}
	}
}
