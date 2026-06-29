package session

import (
	"context"
	"log/slog"
	"time"

	"mandala-exchange/mats/internal/bei"
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
	var activeInstance *bei.SessionInstance
	var activeTemplate *bei.SessionTemplate
	var currentVirtualDayIndex int = int(time.Now().Unix() / 86400)

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

			// Task 0.1: Coba resume atau buat instance baru
			if activeInstance == nil {
				inst, err := d.controller.rules.Client().ActiveSessionInstance(ctx)
				if err != nil {
					d.logger.Error("failed to get active session instance", "error", err)
					continue
				}

				if inst != nil && inst.SessionTemplateID == template.ID {
					// Resume instance yang belum selesai
					activeInstance = inst
					activeTemplate = template
					currentSegmentIdx = inst.CurrentSegmentSequence
					if inst.VirtualDayIndex > currentVirtualDayIndex {
						currentVirtualDayIndex = inst.VirtualDayIndex
					}

					segmentStartedAt = time.Now()
					if inst.RealTimeRemainingSecs != nil {
						if currentSegmentIdx < len(template.Segments) {
							currentSegDur := template.Segments[currentSegmentIdx].DurationSeconds
							elapsed := currentSegDur - *inst.RealTimeRemainingSecs
							segmentStartedAt = time.Now().Add(-time.Duration(elapsed) * time.Second)
						}
					}
					d.controller.SetStatus(ctx, template.Segments[currentSegmentIdx].Status)
					d.logger.Info("resumed session instance", "instance_id", inst.ID, "segment", currentSegmentIdx)
				} else {
					// Buat instance baru
					virtualDur := 0
					for _, s := range template.Segments {
						virtualDur += s.DurationSeconds
					}

					// increment agar tidak tabrakan dengan session sebelumnya di memori yang sama
					currentVirtualDayIndex++

					payload := bei.ActivateSessionPayload{
						SessionTemplateID:      template.ID,
						VirtualDayIndex:        currentVirtualDayIndex,
						VirtualDurationSeconds: virtualDur,
						RealDurationSeconds:    virtualDur,
						MatsNodeID:             "mats-local",
					}
					inst, err := d.controller.rules.Client().ActivateSessionInstance(ctx, payload)
					if err != nil {
						d.logger.Error("failed to activate new session instance", "error", err)
						continue
					}
					activeInstance = inst
					activeTemplate = template
					currentSegmentIdx = 0
					segmentStartedAt = time.Now()
					d.controller.SetStatus(ctx, template.Segments[currentSegmentIdx].Status)

					// Backward compatibility
					if err := d.controller.rules.Client().UpdateSessionStatus(ctx, template.ID, template.Segments[currentSegmentIdx].Status); err != nil {
						d.logger.Error("failed to sync session start to BEI", "error", err)
					}
					d.logger.Info("activated new session instance", "instance_id", inst.ID, "day", currentVirtualDayIndex)
				}
				continue
			}

			if currentSegmentIdx >= len(activeTemplate.Segments) {
				activeInstance = nil // Reset untuk mulai loop baru
				continue
			}

			currentSegment := activeTemplate.Segments[currentSegmentIdx]
			elapsed := time.Since(segmentStartedAt).Seconds()

			if elapsed < float64(currentSegment.DurationSeconds) {
				d.controller.Publish("", "session_timer", map[string]any{
					"status":                 currentSegment.Status,
					"duration_seconds":       currentSegment.DurationSeconds,
					"time_remaining_seconds": currentSegment.DurationSeconds - int(elapsed),
					"occurred_at":            time.Now().UTC(),
				})
			}

			if elapsed >= float64(currentSegment.DurationSeconds) {
				d.logger.Info("session daemon segment ended", "sequence", currentSegmentIdx, "status", currentSegment.Status)

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

				currentSegmentIdx++
				if currentSegmentIdx < len(activeTemplate.Segments) {
					nextSegment := activeTemplate.Segments[currentSegmentIdx]
					segmentStartedAt = time.Now()
					d.controller.SetStatus(ctx, nextSegment.Status)

					if nextSegment.Status == domain.SessionClosed {
						go d.syncSessionClosedWithRetry(ctx, activeTemplate.ID, activeInstance)
						activeInstance = nil // Loop akan reset
					} else {
						if err := d.controller.rules.Client().UpdateSessionStatus(ctx, activeTemplate.ID, nextSegment.Status); err != nil {
							d.logger.Error("failed to sync session segment to BEI", "error", err)
						}
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
					d.logger.Info("all segments completed, looping back to first segment")
					activeInstance = nil // Trigger reset
				}
			}
		}
	}
}

func (d *Daemon) syncSessionClosedWithRetry(ctx context.Context, sessionID string, inst *bei.SessionInstance) {
	for {
		tradeCount, err := d.controller.CountSessionTrades(ctx, sessionID)
		if err != nil {
			d.logger.Warn("failed to count session trades, retrying before finality trigger", "error", err)
			time.Sleep(2 * time.Second)
			continue
		}

		d.controller.PublishSessionClosedFinality(ctx, sessionID, tradeCount)
		d.logger.Info("dispatched session_closed_finality event", "session_id", sessionID, "expected_trade_count", tradeCount)

		// Task 0.1: Finalize instance di BEI
		if inst != nil {
			payload := bei.FinalizeSessionPayload{
				InstanceID: inst.ID,
				Version:    inst.Version,
			}
			_, err = d.controller.rules.Client().FinalizeSessionInstance(ctx, payload)
			if err != nil {
				d.logger.Error("failed to finalize session instance", "error", err)
			} else {
				d.logger.Info("finalized session instance", "instance_id", inst.ID)
			}
		}

		return
	}
}
