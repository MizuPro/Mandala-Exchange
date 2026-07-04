package momentum

import (
	"context"
	"math/rand"
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

type Strategy struct {
	cfg config.MomentumTraderConfig
	rng *rand.Rand
}

func New(cfg config.MomentumTraderConfig) *Strategy {
	return &Strategy{
		cfg: cfg,
		rng: rand.New(rand.NewSource(time.Now().UnixNano())),
	}
}

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
		logger.Debug("Momentum Trader: session order limit reached",
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
			return nil
		}
	case "closing_auction":
		if s.rng.Float64() > s.cfg.ClosingAuctionRate {
			return nil
		}
	case "continuous":
		if bot.IsInactiveForSession(sessionID, s.cfg.InactiveRate, s.rng.Float64()) {
			logger.Debug("Momentum Trader: skip session (inactive roll)",
				"bot_id", bot.ExternalBotID,
				"segment", segment,
			)
			return nil
		}
	}

	// === Parse trading rules dari BEI snapshot ===
	tradingRules := common.ParseTradingRules(beiSnap)
	lotSize := rules.GetDefaultLotSize(tradingRules.LotSizes)

	symbols := common.ListedSymbols(beiSnap)
	if len(symbols) == 0 {
		return nil
	}

	// Evaluasi setiap simbol secara acak hingga menemukan sinyal trading
	shuffledSymbols := make([]string, len(symbols))
	copy(shuffledSymbols, symbols)
	s.rng.Shuffle(len(shuffledSymbols), func(i, j int) {
		shuffledSymbols[i], shuffledSymbols[j] = shuffledSymbols[j], shuffledSymbols[i]
	})

	for _, symbol := range shuffledSymbols {
		segment := matsState.GetSessionSegment()
		if matsState.IsWarmingUp(symbol) && segment != "opening_auction" {
			continue
		}

		signal, exists := matsState.GetSignal(symbol)
		if !exists || signal.LastPrice <= 0 {
			continue
		}

		// Validasi staleness signal (maksimal 30 detik data usang)
		if signal.LastUpdatedAt.IsZero() || time.Since(signal.LastUpdatedAt) > 30*time.Second {
			logger.Debug("Momentum Trader: skip symbol due to stale signal",
				"bot_id", bot.ExternalBotID,
				"symbol", symbol,
				"last_updated", signal.LastUpdatedAt,
			)
			continue
		}

		// === Evaluasi Sinyal & Konfirmasi ===
		var side string
		confirmations := 0

		// Konfirmasi 1: Short Return searah dan melampaui return threshold
		if signal.ShortReturn > s.cfg.ReturnThreshold {
			side = "buy"
			confirmations++
		} else if signal.ShortReturn < -s.cfg.ReturnThreshold {
			side = "sell"
			confirmations++
		}

		if side == "" {
			continue // Tidak ada momentum searah yang cukup kuat
		}

		// Konfirmasi 2: Peningkatan volume perdagangan
		if signal.VolumeDelta > 0 {
			confirmations++
		}

		// Konfirmasi 3: Peningkatan frekuensi perdagangan (trade count)
		if signal.TradeCountDelta > 0 {
			confirmations++
		}

		// Konfirmasi 4: Imbalance order book searah dengan tren
		if side == "buy" && signal.OrderBookImbalance > s.cfg.ImbalanceThreshold {
			confirmations++
		} else if side == "sell" && signal.OrderBookImbalance < -s.cfg.ImbalanceThreshold {
			confirmations++
		}

		// Harus memiliki minimal 2 konfirmasi
		if confirmations < 2 {
			logger.Debug("Momentum Trader: skip symbol — insufficient confirmation",
				"bot_id", bot.ExternalBotID,
				"symbol", symbol,
				"confirmations", confirmations,
				"short_return", signal.ShortReturn,
			)
			continue
		}

		// === Filter Spread ===
		if signal.Spread > 0 {
			spreadPct := float64(signal.Spread) / float64(signal.LastPrice)
			if spreadPct > s.cfg.SpreadThresholdPct {
				logger.Debug("Momentum Trader: skip symbol — spread too wide",
					"bot_id", bot.ExternalBotID,
					"symbol", symbol,
					"spread", signal.Spread,
					"spread_pct", spreadPct,
				)
				continue
			}
		}

		// === Penentuan Harga ===
		tick := getTickSize(signal.LastPrice, tradingRules.TickSizes)
		var proposedPrice int64

		if side == "buy" {
			// Agresif buy: LastPrice + (1 atau 2 Ticks)
			proposedPrice = signal.LastPrice + (int64(s.rng.Intn(2))+1)*tick
		} else {
			// Agresif sell: LastPrice - (1 atau 2 Ticks)
			proposedPrice = signal.LastPrice - (int64(s.rng.Intn(2))+1)*tick
		}

		// Normalisasi harga (clamp ARA/ARB dan snap ke tick terdekat yang valid)
		proposedPrice = common.NormalizeLimitPrice(proposedPrice, signal.LastPrice, tradingRules)
		if proposedPrice <= 0 {
			continue
		}

		// === Safety Brake (Fair Value) ===
		if side == "buy" && len(beiSnap.FairValues) > 0 {
			isBrakeTriggered := false
			for _, fv := range beiSnap.FairValues {
				if fv.Symbol == symbol && fv.FairValue > 0 {
					if float64(proposedPrice) > fv.FairValue*s.cfg.FairValueBrakeMultiplier {
						logger.Debug("Momentum Trader: safety brake triggered — price above multiplier limit",
							"bot_id", bot.ExternalBotID,
							"symbol", symbol,
							"proposed_price", proposedPrice,
							"fair_value", fv.FairValue,
							"limit", fv.FairValue*s.cfg.FairValueBrakeMultiplier,
						)
						isBrakeTriggered = true
					}
					break
				}
			}
			if isBrakeTriggered {
				continue // skip symbol ini dan cari simbol lain
			}
		}

		// === Hitung volume order ===
		availCash, _, _ := bot.GetCash()
		pos := bot.GetPosition(symbol)

		randomLots := int64(s.rng.Intn(int(s.cfg.MaxLotsPerOrder))) + 1

		if side == "sell" {
			maxSellLots := pos.AvailableShares / lotSize
			if randomLots > maxSellLots {
				randomLots = maxSellLots
			}
			if randomLots <= 0 {
				logger.Debug("Momentum Trader: skip sell — insufficient position",
					"bot_id", bot.ExternalBotID,
					"symbol", symbol,
					"available_shares", pos.AvailableShares,
				)
				continue
			}
		}

		if side == "buy" {
			affordableLots := common.AffordableLots(availCash, proposedPrice, lotSize, randomLots)
			if affordableLots <= 0 {
				logger.Debug("Momentum Trader: skip buy — insufficient cash",
					"bot_id", bot.ExternalBotID,
					"symbol", symbol,
					"cash", availCash,
					"needed_cash", proposedPrice*lotSize*randomLots,
				)
				continue
			}
			randomLots = affordableLots
		}

		quantityShares := randomLots * lotSize
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

		logger.Debug("Momentum Trader: decision made",
			"bot_id", bot.ExternalBotID,
			"symbol", symbol,
			"side", side,
			"price", proposedPrice,
			"quantity_shares", quantityShares,
			"confirmations", confirmations,
		)

		return []queue.OrderDecision{decision}
	}

	return nil
}

func getTickSize(price int64, tickRules []rules.TickSizeRule) int64 {
	priceF := float64(price)
	for _, r := range tickRules {
		if priceF < r.MinPrice {
			continue
		}
		if r.MaxPrice != nil && priceF > *r.MaxPrice {
			continue
		}
		return int64(r.TickSize)
	}
	return 1 // Fallback jika tidak ada rules
}
