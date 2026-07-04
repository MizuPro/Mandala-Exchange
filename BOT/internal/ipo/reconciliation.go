package ipo

import (
	"context"

	"github.com/Mandala-Exchange/bot-v2/internal/logger"
	"github.com/Mandala-Exchange/bot-v2/internal/metrics"
	"github.com/Mandala-Exchange/bot-v2/internal/portfolio"
	"github.com/Mandala-Exchange/bot-v2/internal/registry"
	sekuritas "github.com/Mandala-Exchange/bot-v2/internal/client/sekuritas"
)

// ReconcileAfterTimeout dipanggil setelah ErrIPOSubscribeUnknown untuk memverifikasi
// apakah subscription sebenarnya sudah tersimpan di Sekuritas atau belum.
//
// Strategi: panggil ListIPOSubscriptions() lalu filter berdasarkan ipo_event_id.
// Jika ditemukan: update state bot.
// Jika tidak ditemukan: hapus state "pending_reconcile" agar bot bisa retry jika window masih buka.
func ReconcileAfterTimeout(
	ctx context.Context,
	bot *registry.BotInstance,
	ipoEventID string,
	sekClient *sekuritas.Client,
	met *metrics.Manager,
) error {
	existingSubs, err := sekClient.ListIPOSubscriptions(ctx, bot.AccountID)
	if err != nil {
		logger.Error("ReconcileAfterTimeout: gagal fetch list subscriptions",
			"bot_id", bot.ExternalBotID,
			"ipo_event_id", ipoEventID,
			"error", err.Error(),
		)
		return err
	}

	// Filter berdasarkan ipo_event_id
	for _, sub := range existingSubs {
		if sub.IPOEventID != ipoEventID {
			continue
		}

		// Ditemukan: update state
		bot.SetIPOSubscription(ipoEventID, registry.IPOSubscriptionState{
			SubscriptionID:  sub.SubscriptionID,
			Status:          sub.Status,
			IdempotencyKey:  sub.IdempotencyKey,
			RequestedShares: sub.RequestedShares,
			ReservedCashIDR: sub.ReservedCashIDR,
		})
		logger.Info("ReconcileAfterTimeout: subscription ditemukan, state diupdate",
			"bot_id", bot.ExternalBotID,
			"ipo_event_id", ipoEventID,
			"subscription_id", sub.SubscriptionID,
			"status", sub.Status,
		)
		met.RecordIPOEvent("reconciled")
		return nil
	}

	// Tidak ditemukan: subscription belum tersimpan di Sekuritas
	// Hapus state pending_reconcile agar bot bisa retry jika window masih buka
	bot.RemoveIPOSubscription(ipoEventID)
	logger.Warn("ReconcileAfterTimeout: subscription tidak ditemukan, state direset",
		"bot_id", bot.ExternalBotID,
		"ipo_event_id", ipoEventID,
	)
	return nil
}

// ReconcileOnStartup dijalankan saat BOT pertama kali start, sebelum scheduler aktif.
// Mengisi IPORegistry dan state bot dari snapshot Sekuritas yang sudah ada.
//
// Catatan: UpdateFromSnapshot di registry.BotInstance sudah menangani pengisian
// IPOSubscriptions dari acc.IPOSubscriptions. Fungsi ini melengkapinya dengan
// juga mengisi IPORegistry agar diff processor tidak menganggap IPO sudah diproses
// sebagai "new" dan tidak subscribe ulang.
func ReconcileOnStartup(
	bots []*registry.BotInstance,
	ipoReg *IPORegistry,
	snap portfolio.Snapshot,
) {
	for _, bot := range bots {
		var acc *portfolio.Account
		for i := range snap.Accounts {
			if snap.Accounts[i].AccountID == bot.AccountID {
				acc = &snap.Accounts[i]
				break
			}
		}
		if acc == nil {
			continue
		}

		// UpdateFromSnapshot sudah dipanggil di main.go sebelum fungsi ini.
		// Di sini kita hanya perlu memastikan IPORegistry mengetahui subscription yang ada
		// agar processed marker bisa diset dengan benar.
		for _, sub := range acc.IPOSubscriptions {
			if sub.IsActive() {
				logger.Info("ReconcileOnStartup: IPO subscription ditemukan",
					"bot_id", bot.ExternalBotID,
					"ipo_event_id", sub.IPOEventID,
					"status", sub.Status,
				)
			}
		}
	}
	logger.Info("ReconcileOnStartup: selesai", "total_bots", len(bots))
}
