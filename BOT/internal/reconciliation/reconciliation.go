package reconciliation

import (
	"context"
	"fmt"
	"time"

	"github.com/Mandala-Exchange/BOT/internal/client/sekuritas"
	"github.com/Mandala-Exchange/BOT/internal/logger"
	"github.com/Mandala-Exchange/BOT/internal/metrics"
	"github.com/Mandala-Exchange/BOT/internal/portfolio"
)

type Reconciler struct {
	client     *sekuritas.Client
	store      *portfolio.Store
	accountIDs []string
	interval   time.Duration
}

func NewReconciler(client *sekuritas.Client, store *portfolio.Store, accountIDs []string, interval time.Duration) *Reconciler {
	return &Reconciler{client: client, store: store, accountIDs: append([]string(nil), accountIDs...), interval: interval}
}

func (r *Reconciler) Run(ctx context.Context) {
	ticker := time.NewTicker(r.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := r.Once(ctx); err != nil {
				logger.Error("portfolio reconciliation failed", map[string]interface{}{"error": err.Error()})
			}
		}
	}
}

func (r *Reconciler) Once(ctx context.Context) error {
	for start := 0; start < len(r.accountIDs); start += 100 {
		end := start + 100
		if end > len(r.accountIDs) {
			end = len(r.accountIDs)
		}
		snapshot, err := r.client.BulkSnapshot(ctx, r.accountIDs[start:end])
		if err != nil {
			return err
		}
		mismatches := r.store.Compare(snapshot)
		if len(mismatches) > 0 {
			for range mismatches {
				metrics.RecordReconciliationMismatch()
			}
			return fmt.Errorf("source-of-truth mismatch for %d accounts", len(mismatches))
		}
	}
	return nil
}

func (r *Reconciler) Recover(ctx context.Context) error {
	var combined portfolio.Snapshot
	for start := 0; start < len(r.accountIDs); start += 100 {
		end := start + 100
		if end > len(r.accountIDs) {
			end = len(r.accountIDs)
		}
		snapshot, err := r.client.BulkSnapshot(ctx, r.accountIDs[start:end])
		if err != nil {
			return err
		}
		if snapshot.AsOfSequence > combined.AsOfSequence {
			combined.AsOfSequence = snapshot.AsOfSequence
		}
		combined.GeneratedAt = snapshot.GeneratedAt
		combined.Accounts = append(combined.Accounts, snapshot.Accounts...)
	}
	r.store.Replace(combined)
	return nil
}
