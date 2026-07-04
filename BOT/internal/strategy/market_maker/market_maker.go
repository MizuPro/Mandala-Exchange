package marketmaker

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

type Strategy struct {
	cfg config.MarketMakerConfig
	rng *rand.Rand
}

func New(cfg config.MarketMakerConfig) *Strategy {
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

	// === Guard: segment-specific probability check ===
	sessionID := common.SessionID(beiSnap)
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
			return nil
		}
	}

	// === Parse trading rules ===
	tradingRules := common.ParseTradingRules(beiSnap)
	lotSize := rules.GetDefaultLotSize(tradingRules.LotSizes)

	symbols := common.ListedSymbols(beiSnap)
	if len(symbols) == 0 {
		return nil
	}

	var decisions []queue.OrderDecision

	// Evaluasi setiap emiten
	for _, symbol := range symbols {
		// === 1. Deteksi Berita untuk Penarikan/Pelebaran Quote (News Safeguard) ===
		hasHighNews := false
		hasExtremeNews := false

		for i := range beiSnap.News {
			news := beiSnap.News[i]
			// Saring berita yang relevan untuk simbol ini
			if news.Symbol == symbol || (news.Symbol == "" && news.Sector == "") {
				if news.Intensity == "extreme" {
					hasExtremeNews = true
				} else if news.Intensity == "high" {
					hasHighNews = true
				}
			}
		}

		// Withdraw quote saat extreme news
		if hasExtremeNews {
			logger.Debug("Market Maker: quote withdrawn due to extreme news", "bot_id", bot.ExternalBotID, "symbol", symbol)
			continue
		}

		// === 2. Quote Refresh Check (Cancel Existing Quotes) ===
		// Jika ada open order terbuka di Sekuritas untuk bot ini, bersihkan (cancel) terlebih dahulu
		openOrderIDsToCancel := bot.GetAndClearOpenOrderIDs()

		if len(openOrderIDsToCancel) > 0 {
			// Kirim keputusan cancel untuk open orders lama
			for _, ordID := range openOrderIDsToCancel {
				decisions = append(decisions, queue.OrderDecision{
					Action:        "cancel",
					AccountID:     bot.AccountID,
					ClientOrderID: common.ClientOrderID(bot.ExternalBotID, time.Now().UnixNano()),
					TargetOrderID: ordID,
					Symbol:        symbol,
					TTL:           15 * time.Second,
				})
			}
			// Kembalikan aksi cancel saja di tick ini (Cancel-then-Place pattern)
			return decisions
		}

		segment := matsState.GetSessionSegment()
		if matsState.IsWarmingUp(symbol) && segment != "opening_auction" {
			continue
		}

		// === 3. Hitung Reference Mid-Price ===
		var bestBid, bestAsk int64
		bestBidStr, bestAskStr := matsState.GetBestBidAsk(symbol)

		if bPrice, err := strconv.ParseInt(bestBidStr, 10, 64); err == nil && bPrice > 0 {
			bestBid = bPrice
		}
		if aPrice, err := strconv.ParseInt(bestAskStr, 10, 64); err == nil && aPrice > 0 {
			bestAsk = aPrice
		}

		var midPrice int64
		if bestBid > 0 && bestAsk > 0 {
			midPrice = (bestBid + bestAsk) / 2
		} else {
			// Fallback ke LastPrice
			if signal, exists := matsState.GetSignal(symbol); exists && signal.LastPrice > 0 {
				midPrice = signal.LastPrice
			} else if summary, ok := matsState.GetSummary(symbol); ok && summary.Close != "" {
				if v, err := strconv.ParseInt(summary.Close, 10, 64); err == nil && v > 0 {
					midPrice = v
				}
			}
			if midPrice <= 0 && segment == "opening_auction" {
				for i := range beiSnap.IPOs {
					if beiSnap.IPOs[i].Symbol == symbol {
						midPrice = beiSnap.IPOs[i].OfferingPriceIDR
						break
					}
				}
			}
		}

		if midPrice <= 0 {
			continue // skip jika tidak ada reference price
		}

		// === 4. Penentuan Spread & Harga (Bid & Ask Ticks) ===
		tick := getTickSize(midPrice, tradingRules.TickSizes)
		spreadTicks := s.cfg.BaseSpreadTicks
		if hasHighNews {
			spreadTicks *= 2 // lebarkan spread saat volatilitas tinggi
		}

		bidPrice := midPrice - int64(spreadTicks/2)*tick
		askPrice := midPrice + int64(spreadTicks/2)*tick

		// Jaga self-trade prevention: askPrice harus selalu > bidPrice
		if askPrice <= bidPrice {
			askPrice = bidPrice + tick
		}

		bidPrice = common.NormalizeLimitPrice(bidPrice, midPrice, tradingRules)
		askPrice = common.NormalizeLimitPrice(askPrice, midPrice, tradingRules)

		// === 5. Cek Inventory Limits ===
		pos := bot.GetPosition(symbol)
		availCash, _, _ := bot.GetCash()

		allowBid := true
		allowAsk := true

		// Jika kepemilikan saham melebihi limit, matikan quote BID (jangan nimbun lagi)
		if pos.AvailableShares >= s.cfg.MaxInventoryShares {
			allowBid = false
		}
		// Jika kepemilikan saham kosong, matikan quote ASK (tidak punya barang untuk dijual)
		if pos.AvailableShares <= 0 {
			allowAsk = false
		}

		// === 6. Buat Quote Decisions ===
		// Quote Size: acak di bawah maxLotsPerOrder
		randomLots := int64(s.rng.Intn(int(s.cfg.MaxLotsPerOrder))) + 1

		// A. Quote Bid (Buy Limit)
		if allowBid && bidPrice > 0 {
			affordableLots := common.AffordableLots(availCash, bidPrice, lotSize, randomLots)
			if affordableLots > 0 {
				decisions = append(decisions, queue.OrderDecision{
					Action:        "place",
					AccountID:     bot.AccountID,
					ClientOrderID: common.ClientOrderID(bot.ExternalBotID, time.Now().UnixNano()),
					Symbol:        symbol,
					Side:          "buy",
					OrderType:     "limit",
					Price:         bidPrice,
					Quantity:      affordableLots * lotSize,
					TTL:           25 * time.Second,
				})
			}
		}

		// B. Quote Ask (Sell Limit)
		if allowAsk && askPrice > 0 {
			maxSellLots := pos.AvailableShares / lotSize
			sellLots := randomLots
			if sellLots > maxSellLots {
				sellLots = maxSellLots
			}
			if sellLots > 0 {
				decisions = append(decisions, queue.OrderDecision{
					Action:        "place",
					AccountID:     bot.AccountID,
					ClientOrderID: common.ClientOrderID(bot.ExternalBotID, time.Now().UnixNano()),
					Symbol:        symbol,
					Side:          "sell",
					OrderType:     "limit",
					Price:         askPrice,
					Quantity:      sellLots * lotSize,
					TTL:           25 * time.Second,
				})
			}
		}
	}

	return decisions
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
	return 1
}
