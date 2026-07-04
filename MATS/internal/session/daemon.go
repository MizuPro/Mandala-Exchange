package session

import (
	"context"
	"log/slog"
	"time"

	"mandala-exchange/mats/internal/bei"
	"mandala-exchange/mats/internal/domain"
)

type Daemon struct {
	controller        *Controller
	logger            *slog.Logger
	currentSegmentIdx int
	segmentStartedAt  time.Time
	activeInstance    *bei.SessionInstance
	activeTemplate    *bei.SessionTemplate

	// Untuk testing
	now   func() time.Time
	since func(time.Time) time.Duration
}

func NewDaemon(controller *Controller, logger *slog.Logger) *Daemon {
	if logger == nil {
		logger = slog.Default()
	}
	return &Daemon{
		controller:        controller,
		logger:            logger,
		currentSegmentIdx: -1,
		now:               time.Now,
		since:             time.Since,
	}
}

func (d *Daemon) Start(ctx context.Context) {
	d.logger.Info("starting session daemon")
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			d.logger.Info("stopping session daemon")
			return
		case <-ticker.C:
			d.Tick(ctx)
		}
	}
}

func (d *Daemon) Tick(ctx context.Context) {
	template := d.controller.rules.ActiveSessionTemplate()
	if template == nil || len(template.Segments) == 0 {
		return
	}

	// Task 0.1: Coba resume atau buat instance baru
	if d.activeInstance == nil {
		inst, err := d.controller.rules.Client().ActiveSessionInstance(ctx)
		if err != nil {
			d.logger.Error("failed to get active session instance", "error", err)
			return
		}

		if inst != nil && inst.SessionTemplateID == template.ID {
			// Resume instance yang belum selesai
			d.activeInstance = inst
			d.activeTemplate = template
			d.currentSegmentIdx = inst.CurrentSegmentSequence

			d.segmentStartedAt = d.now()
			if inst.RealTimeRemainingSecs != nil {
				if d.currentSegmentIdx < len(template.Segments) {
					currentSegDur := template.Segments[d.currentSegmentIdx].DurationSeconds
					d.segmentStartedAt = resumedSegmentStartedAt(d.now(), currentSegDur, *inst.RealTimeRemainingSecs)
				}
			}
			d.controller.SetStatus(ctx, template.Segments[d.currentSegmentIdx].Status)
			if err := d.syncInstanceProgress(ctx, d.activeInstance, d.currentSegmentIdx, template.Segments[d.currentSegmentIdx]); err != nil {
				d.logger.Error("failed to sync resumed session instance progress to BEI", "error", err)
			}
			d.logger.Info("resumed session instance", "instance_id", inst.ID, "segment", d.currentSegmentIdx)
		} else {
			// Buat instance baru
			realDur := 0
			for _, s := range template.Segments {
				realDur += s.DurationSeconds
			}

			// increment agar tidak tabrakan dengan session sebelumnya di memori yang sama
			// (sekarang ditangani otomatis oleh BEI backend jika dikirim 0)

			// VirtualDurationSeconds di-hardcode ke 8 jam (28800 detik) untuk
			// mewakili 1 hari perdagangan penuh dalam waktu virtual, sehingga
			// rasio waktu bot berjalan lebih cepat (time compression).
			payload := bei.ActivateSessionPayload{
				SessionTemplateID:      template.ID,
				VirtualDayIndex:        0,
				VirtualDurationSeconds: 28800,
				RealDurationSeconds:    realDur,
				MatsNodeID:             "mats-local",
			}
			inst, err := d.controller.rules.Client().ActivateSessionInstance(ctx, payload)
			if err != nil {
				d.logger.Error("failed to activate new session instance", "error", err)
				return
			}
			d.activeInstance = inst
			d.activeTemplate = template
			d.currentSegmentIdx = 0
			d.segmentStartedAt = d.now()
			d.controller.SetStatus(ctx, template.Segments[d.currentSegmentIdx].Status)
			if err := d.syncInstanceProgress(ctx, d.activeInstance, d.currentSegmentIdx, template.Segments[d.currentSegmentIdx]); err != nil {
				d.logger.Error("failed to sync new session instance progress to BEI", "error", err)
			}

			// Backward compatibility
			if err := d.controller.rules.Client().UpdateSessionStatus(ctx, template.ID, template.Segments[d.currentSegmentIdx].Status); err != nil {
				d.logger.Error("failed to sync session start to BEI", "error", err)
			}
			d.logger.Info("activated new session instance", "instance_id", inst.ID, "day", inst.VirtualDayIndex)
		}
		return
	}

	if d.currentSegmentIdx >= len(d.activeTemplate.Segments) {
		d.activeInstance = nil // Reset untuk mulai loop baru
		return
	}

	currentSegment := d.activeTemplate.Segments[d.currentSegmentIdx]
	elapsed := d.since(d.segmentStartedAt).Seconds()

	if elapsed < float64(currentSegment.DurationSeconds) {
		remaining := currentSegment.DurationSeconds - int(elapsed)
		d.controller.Publish("", "session_timer", map[string]any{
			"status":                 currentSegment.Status,
			"duration_seconds":       currentSegment.DurationSeconds,
			"time_remaining_seconds": remaining,
			"occurred_at":            d.now().UTC(),
		})
		if err := d.controller.rules.Client().UpdateSessionInstanceProgress(ctx, bei.UpdateSessionInstanceProgressPayload{
			InstanceID:               d.activeInstance.ID,
			Status:                   currentSegment.Status,
			CurrentSegmentSequence:   d.currentSegmentIdx,
			RealTimeRemainingSeconds: remaining,
		}); err != nil {
			d.logger.Error("failed to sync session timer to BEI", "error", err)
		}
	}

	if elapsed >= float64(currentSegment.DurationSeconds) {
		d.logger.Info("session daemon segment ended", "sequence", d.currentSegmentIdx, "status", currentSegment.Status)

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

		if currentSegment.Status == domain.SessionClosed {
			go d.syncSessionClosedWithRetry(ctx, d.activeTemplate.ID, d.activeInstance)
		}

		d.currentSegmentIdx++
		if d.currentSegmentIdx < len(d.activeTemplate.Segments) {
			nextSegment := d.activeTemplate.Segments[d.currentSegmentIdx]
			d.segmentStartedAt = d.now()
			d.controller.SetStatus(ctx, nextSegment.Status)
			
			if err := d.syncInstanceProgress(ctx, d.activeInstance, d.currentSegmentIdx, nextSegment); err != nil {
				d.logger.Error("failed to sync session segment progress to BEI", "error", err)
			}

			if err := d.controller.rules.Client().UpdateSessionStatus(ctx, d.activeTemplate.ID, nextSegment.Status); err != nil {
				d.logger.Error("failed to sync session segment to BEI", "error", err)
			}
			d.logger.Info("session daemon started segment", "sequence", d.currentSegmentIdx, "status", nextSegment.Status)

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
			d.activeInstance = nil // Trigger reset
		}
	}
}

func resumedSegmentStartedAt(now time.Time, segmentDurationSeconds, remainingSeconds int) time.Time {
	if segmentDurationSeconds <= 0 || remainingSeconds < 0 || remainingSeconds > segmentDurationSeconds {
		return now
	}
	elapsed := segmentDurationSeconds - remainingSeconds
	return now.Add(-time.Duration(elapsed) * time.Second)
}

func (d *Daemon) syncInstanceProgress(ctx context.Context, inst *bei.SessionInstance, segmentIdx int, segment bei.SessionSegment) error {
	if inst == nil {
		return nil
	}
	return d.controller.rules.Client().UpdateSessionInstanceProgress(ctx, bei.UpdateSessionInstanceProgressPayload{
		InstanceID:               inst.ID,
		Status:                   segment.Status,
		CurrentSegmentSequence:   segmentIdx,
		RealTimeRemainingSeconds: segment.DurationSeconds,
	})
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

func (d *Daemon) SetClock(now func() time.Time, since func(time.Time) time.Duration) {
	d.now = now
	d.since = since
}

func (d *Daemon) GetSessionSegmentStatus() domain.SessionStatus {
	if d.activeTemplate == nil || d.currentSegmentIdx < 0 || d.currentSegmentIdx >= len(d.activeTemplate.Segments) {
		return ""
	}
	return d.activeTemplate.Segments[d.currentSegmentIdx].Status
}
