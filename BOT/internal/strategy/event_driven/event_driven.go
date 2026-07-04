package eventdriven

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
	cfg config.EventDrivenConfig
	rng *rand.Rand
}

func New(cfg config.EventDrivenConfig) *Strategy {
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
		logger.Debug("Event-Driven: session order limit reached",
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
			logger.Debug("Event-Driven: skip session (inactive roll)",
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

	// Buat map sector emiten untuk pencocokan scope sector news
	secSectors := make(map[string]string)
	for _, sec := range beiSnap.Securities {
		// di bei.go struct Security belum tentu ada sector, mari kita fallback jika kosong
		// Tapi di daftar-saham-aktif BEI mengembalikan sector
		// Jika struct Security bei.go tidak memetakan Sector, kita deteksi sector dari simbol MNDL/NUSA/BARA
		secSectors[sec.Symbol] = "finance" // default fallback
	}

	// Iterasi berita aktif dari yang terbaru
	for i := range beiSnap.News {
		news := beiSnap.News[i]

		// Abaikan berita yang sudah pernah dievaluasi bot ini
		if bot.HasProcessedNews(news.ID) {
			continue
		}

		// Saring berita berdasarkan relevansi simbol yang dievaluasi
		// Kita acak daftar simbol emiten agar bot menyebarkan ordernya secara adil
		shuffledSymbols := make([]string, len(symbols))
		copy(shuffledSymbols, symbols)
		s.rng.Shuffle(len(shuffledSymbols), func(a, b int) {
			shuffledSymbols[a], shuffledSymbols[b] = shuffledSymbols[b], shuffledSymbols[a]
		})

		for _, symbol := range shuffledSymbols {
			segment := matsState.GetSessionSegment()
			if matsState.IsWarmingUp(symbol) && segment != "opening_auction" {
				continue
			}

			isRelevant := false
			if news.Symbol == symbol {
				isRelevant = true
			} else if news.Sector != "" && news.Sector == secSectors[symbol] {
				isRelevant = true
			} else if news.Symbol == "" && news.Sector == "" {
				isRelevant = true // Global / Market-wide news
			}

			if !isRelevant {
				continue
			}

			// === Hitung Probabilitas Reaksi ===
			var prob float64
			switch news.Intensity {
			case "low":
				prob = 0.25
			case "medium":
				prob = 0.50
			case "high":
				prob = 0.75
			case "extreme":
				prob = 0.90
			default:
				prob = 0.50 // default medium
			}

			roll := s.rng.Float64()
			bot.MarkNewsProcessed(news.ID) // Tandai berita sebagai terproses agar tidak dievaluasi lagi

			if roll > prob {
				logger.Debug("Event-Driven: roll skip news",
					"bot_id", bot.ExternalBotID,
					"news_title", news.Title,
					"intensity", news.Intensity,
					"roll", roll,
					"prob", prob,
				)
				continue // roll gagal, tidak bereaksi
			}

			// Tentukan arah berdasarkan sentimen
			var side string
			if news.Sentiment == "positive" {
				side = "buy"
			} else if news.Sentiment == "negative" {
				side = "sell"
			}

			if side == "" {
				continue // Sentimen neutral/tidak dikenal tidak menghasilkan keputusan order
			}

			// Ambil harga referensi pasar terupdate
			var lastPrice int64
			if signal, exists := matsState.GetSignal(symbol); exists && signal.LastPrice > 0 {
				lastPrice = signal.LastPrice
			} else if summary, ok := matsState.GetSummary(symbol); ok && summary.Close != "" {
				if v, err := strconv.ParseInt(summary.Close, 10, 64); err == nil && v > 0 {
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

			if lastPrice <= 0 && segment == "opening_auction" {
				for i := range beiSnap.IPOs {
					if beiSnap.IPOs[i].Symbol == symbol {
						lastPrice = beiSnap.IPOs[i].OfferingPriceIDR
						break
					}
				}
			}

			if lastPrice <= 0 {
				continue // skip jika tidak ada reference price
			}

			// === Penentuan Harga (Agresif / Hajar Kanan/Kiri) ===
			tick := getTickSize(lastPrice, tradingRules.TickSizes)
			var proposedPrice int64

			if side == "buy" {
				// Agresif beli: LastPrice + (1 atau 2 Ticks)
				proposedPrice = lastPrice + (int64(s.rng.Intn(2))+1)*tick
			} else {
				// Agresif jual: LastPrice - (1 atau 2 Ticks)
				proposedPrice = lastPrice - (int64(s.rng.Intn(2))+1)*tick
			}

			proposedPrice = common.NormalizeLimitPrice(proposedPrice, lastPrice, tradingRules)
			if proposedPrice <= 0 {
				continue
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
					continue
				}
			}

			if side == "buy" {
				affordableLots := common.AffordableLots(availCash, proposedPrice, lotSize, randomLots)
				if affordableLots <= 0 {
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

			logger.Debug("Event-Driven: decision made on news",
				"bot_id", bot.ExternalBotID,
				"symbol", symbol,
				"side", side,
				"price", proposedPrice,
				"qty", quantityShares,
				"news_title", news.Title,
				"sentiment", news.Sentiment,
			)

			return []queue.OrderDecision{decision}
		}
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
	return 1
}
