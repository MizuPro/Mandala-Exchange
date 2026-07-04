// Package noise mengimplementasikan Noise Trader strategy untuk BOT-v2.
//
// Noise Trader adalah bot yang bereaksi secara dangkal ke harga dan pasar,
// tanpa analisis fundamental atau teknikal yang dalam. Ia membuat order
// secara random dengan pembatasan yang wajar agar tidak merusak market.
//
// Perilaku sesuai BOT_V2_AGENT_BEHAVIOR.md:
//   - Inactive rate per session: 15% (tidak selalu order)
//   - Interval evaluasi di continuous: 30-90 detik
//   - Max order per session: 0-2
//   - Order di opening auction: ~15% chance
//   - Order di closing auction: ~8% chance
//   - Hampir tidak peduli fair value (hanya risk filter kecil jika harga > 2x fair value)
package noise

import (
	"context"
	"math/rand"
	"strconv"
	"time"

	"github.com/Mandala-Exchange/bot-v2/internal/client/bei"
	"github.com/Mandala-Exchange/bot-v2/internal/client/mats"
	"github.com/Mandala-Exchange/bot-v2/internal/config"
	"github.com/Mandala-Exchange/bot-v2/internal/logger"
	"github.com/Mandala-Exchange/bot-v2/internal/queue"
	"github.com/Mandala-Exchange/bot-v2/internal/registry"
	"github.com/Mandala-Exchange/bot-v2/internal/strategy/common"
	"github.com/Mandala-Exchange/bot-v2/internal/strategy/rules"
)

// Strategy mengimplementasikan logika Noise Trader.
type Strategy struct {
	cfg config.NoiseTraderConfig
	rng *rand.Rand // instance rand per-strategy, tidak di-share (thread safe via caller guarantee)
}

// New membuat instance Noise Trader Strategy baru.
func New(cfg config.NoiseTraderConfig) *Strategy {
	return &Strategy{
		cfg: cfg,
		rng: rand.New(rand.NewSource(time.Now().UnixNano())),
	}
}

// Decide menghasilkan keputusan order untuk satu bot pada satu tick sesi.
// Dipanggil dari runner.RunBotDecisions.
func (s *Strategy) Decide(
	_ context.Context,
	bot *registry.BotInstance,
	beiSnap bei.Snapshot,
	matsState *mats.MarketState,
	segment string,
) []queue.OrderDecision {
	// === Guard: hanya order di segment yang diizinkan ===
	if !common.AllowedOrderSegment(segment) {
		return nil
	}

	// === Guard: bot tidak aktif ===
	status := bot.GetStatus()
	if status == "bankrupt" || status == "paused" {
		return nil
	}

	// === Guard: sudah mencapai batas order sesi ini ===
	sessionID := common.SessionID(beiSnap)
	ordersThisSession := bot.GetOrdersThisSession(sessionID)
	if ordersThisSession >= s.cfg.MaxOrdersPerSession {
		logger.Debug("Noise Trader: session order limit reached",
			"bot_id", bot.ExternalBotID,
			"orders_this_session", ordersThisSession,
			"max", s.cfg.MaxOrdersPerSession,
		)
		return nil
	}

	// === Guard: segment-specific probability check ===
	switch segment {
	case "opening_auction":
		if s.rng.Float64() > s.cfg.OpeningAuctionRate {
			return nil // bot ini tidak ikut opening auction
		}
	case "closing_auction":
		if s.rng.Float64() > s.cfg.ClosingAuctionRate {
			return nil // bot ini tidak ikut closing auction
		}
	case "continuous":
		// Inactive roll ditentukan sekali untuk setiap session instance.
		if bot.IsInactiveForSession(sessionID, s.cfg.InactiveRate, s.rng.Float64()) {
			logger.Debug("Noise Trader: skip session (inactive roll)",
				"bot_id", bot.ExternalBotID,
				"segment", segment,
			)
			return nil
		}
	}

	// === Parse trading rules dari BEI snapshot ===
	tradingRules := common.ParseTradingRules(beiSnap)
	lotSize := rules.GetDefaultLotSize(tradingRules.LotSizes) // biasanya 100

	// === Pilih simbol secara random dari daftar simbol MATS ===
	symbols := common.ListedSymbols(beiSnap)
	if len(symbols) == 0 {
		return nil
	}
	symbol := symbols[s.rng.Intn(len(symbols))]

	// === Ambil harga referensi ===
	lastPriceRaw := matsState.GetLastPrice(symbol)
	lastPrice, err := strconv.ParseInt(lastPriceRaw, 10, 64)
	if err != nil || lastPrice <= 0 {
		// Fallback: gunakan market summary close price
		if summary, hasSummary := matsState.GetSummary(symbol); hasSummary && summary.Close != "" {
			if v, err2 := strconv.ParseInt(summary.Close, 10, 64); err2 == nil && v > 0 {
				lastPrice = v
			}
		}
		if lastPrice <= 0 {
			// Fallback final: gunakan average price dari portfolio bot jika ada
			pos := bot.GetPosition(symbol)
			if pos.AveragePriceIDR > 0 {
				lastPrice = pos.AveragePriceIDR
			}
		}
		if lastPrice <= 0 {
			logger.Debug("Noise Trader: no reference price available",
				"bot_id", bot.ExternalBotID,
				"symbol", symbol,
			)
			return nil
		}
	}

	// === Pilih side secara random ===
	// Jika bot tidak punya posisi, hanya bisa buy
	availCash, _, _ := bot.GetCash()
	pos := bot.GetPosition(symbol)
	canSell := pos.AvailableShares >= lotSize
	canBuy := availCash >= lastPrice*lotSize // rough check

	var side string
	if canSell && canBuy {
		if s.rng.Intn(2) == 0 {
			side = "buy"
		} else {
			side = "sell"
		}
	} else if canBuy {
		side = "buy"
	} else if canSell {
		side = "sell"
	} else {
		logger.Debug("Noise Trader: skip — neither can buy nor sell",
			"bot_id", bot.ExternalBotID,
			"symbol", symbol,
			"cash", availCash,
			"available_shares", pos.AvailableShares,
		)
		return nil
	}

	// === Hitung harga dengan noise ===
	// Noise: random offset antara -pct sampai +pct dari lastPrice
	noiseFactor := 1.0 + (s.rng.Float64()*2-1)*s.cfg.PriceNoisePct
	proposedPriceF := float64(lastPrice) * noiseFactor
	proposedPrice := int64(proposedPriceF)

	// Snap ke tick size
	proposedPrice = common.NormalizeLimitPrice(proposedPrice, lastPrice, tradingRules)

	if proposedPrice <= 0 {
		return nil
	}

	// === Fair value safety check (Noise Trader hanya peduli jika harga SANGAT mahal) ===
	if side == "buy" && len(beiSnap.FairValues) > 0 {
		for _, fv := range beiSnap.FairValues {
			if fv.Symbol == symbol && fv.FairValue > 0 {
				// Jika harga > 2x fair value, noise trader tidak mau beli (hanya FOMO kecil)
				if float64(proposedPrice) > fv.FairValue*2.0 {
					if s.rng.Float64() > 0.05 { // hanya 5% chance tetap beli
						logger.Debug("Noise Trader: skip buy — price too far above fair value",
							"bot_id", bot.ExternalBotID,
							"symbol", symbol,
							"price", proposedPrice,
							"fair_value", fv.FairValue,
						)
						return nil
					}
				}
				break
			}
		}
	}

	// === Hitung quantity (dalam lembar saham = lot * lotSize) ===
	maxLots := s.cfg.MaxLotsPerOrder
	randomLots := int64(s.rng.Intn(int(maxLots))) + 1 // 1 sampai maxLots lot

	if side == "sell" {
		// Tidak boleh jual lebih dari available
		maxSellLots := pos.AvailableShares / lotSize
		if randomLots > maxSellLots {
			randomLots = maxSellLots
		}
		if randomLots <= 0 {
			return nil
		}
	}

	if side == "buy" {
		// Tidak boleh beli lebih dari buying power
		totalCost := proposedPrice * randomLots * lotSize
		if totalCost > availCash {
			// Kurangi lot agar sesuai budget
			affordableLots := availCash / (proposedPrice * lotSize)
			if affordableLots <= 0 {
				logger.Debug("Noise Trader: skip buy — insufficient cash",
					"bot_id", bot.ExternalBotID,
					"symbol", symbol,
					"cash", availCash,
					"price", proposedPrice,
					"lot_size", lotSize,
				)
				return nil
			}
			if affordableLots < randomLots {
				randomLots = affordableLots
			}
		}
	}

	quantityShares := randomLots * lotSize

	// === Buat client_order_id dengan format: bot:{botID}:{uuid}:{seq} ===
	clientOrderID := common.ClientOrderID(bot.ExternalBotID, time.Now().UnixNano())

	decision := queue.OrderDecision{
		AccountID:     bot.AccountID,
		ClientOrderID: clientOrderID,
		Symbol:        symbol,
		Side:          side,
		OrderType:     "limit",
		Price:         proposedPrice,
		Quantity:      quantityShares,
		TTL:           30 * time.Second,
	}

	logger.Debug("Noise Trader: decision made",
		"bot_id", bot.ExternalBotID,
		"symbol", symbol,
		"side", side,
		"price", proposedPrice,
		"quantity_shares", quantityShares,
		"lots", randomLots,
		"segment", segment,
		"session_id", sessionID,
	)

	return []queue.OrderDecision{decision}
}
