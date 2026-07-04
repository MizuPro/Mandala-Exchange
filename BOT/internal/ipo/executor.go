package ipo

import (
	"context"
	"errors"
	"fmt"

	"github.com/Mandala-Exchange/bot-v2/internal/logger"
	"github.com/Mandala-Exchange/bot-v2/internal/metrics"
	"github.com/Mandala-Exchange/bot-v2/internal/registry"
	sekuritas "github.com/Mandala-Exchange/bot-v2/internal/client/sekuritas"
)

// Execute mengirim subscription IPO ke Sekuritas untuk satu bot.
//
// PENTING: Executor ini memanggil sekuritasClient.SubscribeIPO() secara langsung.
// Subscription IPO DILARANG KERAS melewati queue.OrderQueue agar tidak
// menghitung IPO subscription sebagai order sesi biasa.
func Execute(
	ctx context.Context,
	bot *registry.BotInstance,
	decision SubscriptionDecision,
	sekClient *sekuritas.Client,
	ipoReg *IPORegistry,
	met *metrics.Manager,
) error {
	logger.Info("IPO Execute: mengirim subscription",
		"bot_id", bot.ExternalBotID,
		"ipo_event_id", decision.IPOEventID,
		"requested_shares", decision.RequestedShares,
		"idempotency_key", decision.IdempotencyKey,
	)

	met.RecordIPOEvent("attempted")

	resp, err := sekClient.SubscribeIPO(
		ctx,
		bot.AccountID,
		decision.IPOEventID,
		decision.RequestedShares,
		decision.IdempotencyKey,
	)

	if err != nil {
		if errors.Is(err, sekuritas.ErrIPOSubscribeTerminal) {
			// 4xx non-retryable: tidak perlu retry, catat sebagai failed
			logger.Error("IPO subscribe terminal error",
				"bot_id", bot.ExternalBotID,
				"ipo_event_id", decision.IPOEventID,
				"error", err.Error(),
			)
			met.RecordIPOEvent("failed")
			// Tandai sebagai processed agar tidak dicoba lagi di tick berikutnya
			ipoReg.MarkProcessed(decision.IPOEventID, decision.DecisionVersion)
			return err
		}

		if errors.Is(err, sekuritas.ErrIPOSubscribeUnknown) {
			// Network error/5xx: outcome tidak diketahui — simpan state pending
			logger.Warn("IPO subscribe outcome unknown, marking for reconcile",
				"bot_id", bot.ExternalBotID,
				"ipo_event_id", decision.IPOEventID,
				"idempotency_key", decision.IdempotencyKey,
			)
			// Simpan state "pending_reconcile" agar reconciler bisa pickup
			bot.SetIPOSubscription(decision.IPOEventID, registry.IPOSubscriptionState{
				SubscriptionID:  "",
				Status:          "pending_reconcile",
				IdempotencyKey:  decision.IdempotencyKey,
				DecisionVersion: decision.DecisionVersion,
				RequestedShares: decision.RequestedShares,
			})
			return fmt.Errorf("ipo subscribe unknown outcome: %w", err)
		}

		return err
	}

	// Sukses: update state bot
	bot.SetIPOSubscription(decision.IPOEventID, registry.IPOSubscriptionState{
		SubscriptionID:  resp.SubscriptionID,
		Status:          resp.Status,
		IdempotencyKey:  decision.IdempotencyKey,
		DecisionVersion: decision.DecisionVersion,
		RequestedShares: resp.RequestedShares,
		ReservedCashIDR: resp.ReservedCashIDR,
	})
	ipoReg.MarkProcessed(decision.IPOEventID, decision.DecisionVersion)
	met.RecordIPOEvent("accepted")

	logger.Info("IPO subscription berhasil",
		"bot_id", bot.ExternalBotID,
		"ipo_event_id", decision.IPOEventID,
		"subscription_id", resp.SubscriptionID,
		"status", resp.Status,
	)
	return nil
}
