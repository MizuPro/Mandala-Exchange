package reconciliation

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/Mandala-Exchange/BOT/internal/client/sekuritas"
	"github.com/Mandala-Exchange/BOT/internal/logger"
	"github.com/Mandala-Exchange/BOT/internal/portfolio"
)

// ErrSequenceTooOld is returned by the event stream when the requested
// after_sequence is beyond the server's retention window.
// Per BOT_API_CONTRACTS.md §7.1: server returns 410 EVENT_SEQUENCE_TOO_OLD.
// The BOT must take a fresh snapshot and replay from as_of_sequence+1.
var ErrSequenceTooOld = errors.New("event sequence too old: must snapshot and replay")

// StreamConsumer connects to the Sekuritas account event stream and applies
// events to the portfolio store. It handles:
//
//   - Reconnect with exponential backoff
//   - Gap detection (ErrSequenceGap) → triggers snapshot-and-replay
//   - 410 EVENT_SEQUENCE_TOO_OLD → triggers snapshot-and-replay
//   - Slow consumer disconnect → triggers snapshot-and-replay
//
// Per BOT_STATE_MACHINES.md §11: reconciliation state machine:
//
//	healthy → suspected_gap → paused_for_reconciliation → snapshot_loading
//	→ replaying_after_snapshot → verified → healthy
//
// The consumer does NOT write corrections to Sekuritas; it only reads and applies events.
type StreamConsumer struct {
	client     *sekuritas.Client
	store      *portfolio.Store
	reconciler *Reconciler
}

// NewStreamConsumer creates a StreamConsumer.
func NewStreamConsumer(client *sekuritas.Client, store *portfolio.Store, reconciler *Reconciler) *StreamConsumer {
	return &StreamConsumer{client: client, store: store, reconciler: reconciler}
}

// Run starts the stream consumer loop. It blocks until ctx is cancelled.
//
// Loop behaviour:
//  1. Recover: take a fresh consistent snapshot (sets lastSequence = as_of_sequence).
//  2. Stream: consume events from lastSequence+1.
//  3. On ErrSequenceGap or 410 (ErrSequenceTooOld): go back to step 1.
//  4. On normal disconnect: reconnect after backoff.
//  5. On ctx.Done: exit cleanly.
func (c *StreamConsumer) Run(ctx context.Context) {
	backoff := 250 * time.Millisecond
	for ctx.Err() == nil {
		// ── Step 1: Snapshot Recovery ──────────────────────────────────────────
		logger.Info("Account stream: taking portfolio snapshot for recovery", nil)
		if err := c.reconciler.Recover(ctx); err != nil {
			if errors.Is(err, context.Canceled) {
				return
			}
			logger.Error("Account stream: snapshot recovery failed", map[string]interface{}{
				"error": err.Error(),
			})
			c.sleepOrDone(ctx, backoff)
			backoff = growBackoff(backoff)
			continue
		}

		// Reset backoff after successful snapshot
		backoff = 250 * time.Millisecond
		logger.Info("Account stream: snapshot recovered, starting stream", map[string]interface{}{
			"after_sequence": c.store.LastSequence(),
		})

		// ── Step 2: Stream Events ───────────────────────────────────────────────
		err := c.client.ConnectEventStream(ctx, c.store.LastSequence(), func(event portfolio.Event) error {
			applyErr := c.store.Apply(event)
			if errors.Is(applyErr, portfolio.ErrSequenceGap) {
				// Gap detected: return error to break the stream loop.
				// StreamConsumer will snapshot-and-replay.
				logger.Warn("Account stream: sequence gap detected — will snapshot-and-replay", map[string]interface{}{
					"expected": c.store.LastSequence() + 1,
					"received": event.Sequence,
				})
				return fmt.Errorf("sequence gap at event %d: %w", event.Sequence, portfolio.ErrSequenceGap)
			}
			return applyErr
		})

		// ── Step 3: Error Classification ────────────────────────────────────────
		if errors.Is(err, context.Canceled) {
			return
		}

		if err != nil {
			// Check for 410 EVENT_SEQUENCE_TOO_OLD (server closed the stream because
			// our checkpoint is beyond the retention window).
			if isSequenceTooOld(err) {
				logger.Warn("Account stream: sequence too old (410), will take fresh snapshot", map[string]interface{}{
					"checkpoint": c.store.LastSequence(),
				})
				// Loop immediately back to snapshot-and-replay without extra backoff.
				continue
			}

			// Sequence gap detected from handler error
			if errors.Is(err, portfolio.ErrSequenceGap) {
				logger.Warn("Account stream: gap → snapshot-and-replay", nil)
				continue
			}

			// Any other error (connection reset, timeout, slow_consumer disconnect):
			// log and reconnect with backoff.
			logger.Warn("Account stream: connection interrupted, will reconnect", map[string]interface{}{
				"error": err.Error(),
			})
			c.sleepOrDone(ctx, backoff)
			backoff = growBackoff(backoff)
			continue
		}

		// Clean exit from stream (server-side close without error): reconnect.
		c.sleepOrDone(ctx, backoff)
		backoff = growBackoff(backoff)
	}
}

// isSequenceTooOld returns true if the error indicates a 410 EVENT_SEQUENCE_TOO_OLD
// response from the Sekuritas account event stream.
//
// Two possible error sources:
//  1. *client.APIError with Code "EVENT_SEQUENCE_TOO_OLD" (from HTTP error envelope)
//  2. websocket.Dial HTTP 410 before upgrade: error message contains "status 410"
//     (format: "account stream dial status 410: <reason>")
func isSequenceTooOld(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return contains(msg, "EVENT_SEQUENCE_TOO_OLD") ||
		contains(msg, "status=410") ||
		contains(msg, "status 410")
}

// contains is a simple substring check (avoids importing strings in this file).
func contains(s, sub string) bool {
	if len(sub) > len(s) {
		return false
	}
	for i := 0; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

// sleepOrDone sleeps for d or until ctx is cancelled.
func (c *StreamConsumer) sleepOrDone(ctx context.Context, d time.Duration) {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
	case <-timer.C:
	}
}

// growBackoff doubles the backoff, capped at 8 seconds.
func growBackoff(d time.Duration) time.Duration {
	if d < 8*time.Second {
		return d * 2
	}
	return 8 * time.Second
}
