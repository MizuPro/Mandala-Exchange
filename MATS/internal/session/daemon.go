package session

import (
	"context"
	"log/slog"
	"time"

	"mandala-exchange/mats/internal/domain"
)

type Daemon struct {
	controller *Controller
	logger     *slog.Logger
}

func NewDaemon(controller *Controller, logger *slog.Logger) *Daemon {
	return &Daemon{
		controller: controller,
		logger:     logger,
	}
}

func (d *Daemon) Start(ctx context.Context) {
	d.logger.Info("starting session daemon")
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	var currentSegmentIdx int = -1
	var segmentStartedAt time.Time

	for {
		select {
		case <-ctx.Done():
			d.logger.Info("stopping session daemon")
			return
		case <-ticker.C:
			template := d.controller.rules.ActiveSessionTemplate()
			if template == nil || len(template.Segments) == 0 {
				continue
			}

			// Initialize if just starting
			if currentSegmentIdx == -1 {
				currentSegmentIdx = 0
				segmentStartedAt = time.Now()
				d.controller.SetStatus(ctx, template.Segments[currentSegmentIdx].Status)
				if err := d.controller.rules.Client().UpdateSessionStatus(ctx, template.ID, template.Segments[currentSegmentIdx].Status); err != nil {
					d.logger.Error("failed to sync session start to BEI", "error", err)
				}
				d.logger.Info("session daemon started segment", "sequence", currentSegmentIdx, "status", template.Segments[currentSegmentIdx].Status)
				continue
			}

			if currentSegmentIdx >= len(template.Segments) {
				continue // Session completed all segments
			}

			currentSegment := template.Segments[currentSegmentIdx]
			elapsed := time.Since(segmentStartedAt).Seconds()

			// Publish session timer every second
			if elapsed < float64(currentSegment.DurationSeconds) {
				d.controller.Publish("", "session_timer", map[string]any{
					"status":                 currentSegment.Status,
					"duration_seconds":       currentSegment.DurationSeconds,
					"time_remaining_seconds": currentSegment.DurationSeconds - int(elapsed),
					"occurred_at":            time.Now().UTC(),
				})
			}

			if elapsed >= float64(currentSegment.DurationSeconds) {
				// End of current segment
				d.logger.Info("session daemon segment ended", "sequence", currentSegmentIdx, "status", currentSegment.Status)
				
				// Auto Uncross if ending an auction
				if currentSegment.Status == domain.SessionOpeningAuction || currentSegment.Status == domain.SessionClosingAuction {
					symbols := d.controller.rules.ListedSymbols()
					for _, sym := range symbols {
						_, trades, _, err := d.controller.UncrossAuction(ctx, sym)
						if err != nil {
							d.logger.Error("auto-uncross failed", "symbol", sym, "error", err)
						} else if len(trades) > 0 {
							d.logger.Info("auto-uncross completed", "symbol", sym, "trades", len(trades))
						}
					}
				}

				// Auto Expire if ending session (moving to closed or after post-closing)
				// Or wait until we transition TO closed?
				
				// Move to next segment
				currentSegmentIdx++
				if currentSegmentIdx < len(template.Segments) {
					nextSegment := template.Segments[currentSegmentIdx]
					segmentStartedAt = time.Now()
					d.controller.SetStatus(ctx, nextSegment.Status)
					if err := d.controller.rules.Client().UpdateSessionStatus(ctx, template.ID, nextSegment.Status); err != nil {
						d.logger.Error("failed to sync session segment to BEI", "error", err)
					}
					d.logger.Info("session daemon started segment", "sequence", currentSegmentIdx, "status", nextSegment.Status)

					if nextSegment.Status == domain.SessionClosed {
						expired, err := d.controller.ExpireOpenOrders(ctx)
						if err != nil {
							d.logger.Error("auto-expire orders failed", "error", err)
						} else {
							d.logger.Info("auto-expire orders completed", "count", len(expired))
						}
					}
				} else {
					// All segments done, move to closed if not already
					if currentSegment.Status != domain.SessionClosed {
						d.controller.SetStatus(ctx, domain.SessionClosed)
						if err := d.controller.rules.Client().UpdateSessionStatus(ctx, template.ID, domain.SessionClosed); err != nil {
							d.logger.Error("failed to sync session closed to BEI", "error", err)
						}
						expired, err := d.controller.ExpireOpenOrders(ctx)
						if err != nil {
							d.logger.Error("auto-expire orders failed", "error", err)
						} else {
							d.logger.Info("auto-expire orders completed", "count", len(expired))
						}
					}
				}
			}
		}
	}
}
