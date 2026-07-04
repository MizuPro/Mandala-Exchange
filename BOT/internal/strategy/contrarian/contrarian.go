package contrarian

import (
	"context"
	"math"
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
	cfg config.ContrarianConfig
	rng *rand.Rand
}

func New(cfg config.ContrarianConfig) *Strategy {
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
		logger.Debug("Contrarian: session order limit reached",
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
			logger.Debug("Contrarian: skip session (inactive roll)",
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

	// Evaluasi setiap simbol secara acak
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
			logger.Debug("Contrarian: skip symbol due to stale signal",
				"bot_id", bot.ExternalBotID,
				"symbol", symbol,
				"last_updated", signal.LastUpdatedAt,
			)
			continue
		}

		// Ambil Fair Value untuk simbol ini
		var fv *bei.FairValue
		for i := range beiSnap.FairValues {
			if beiSnap.FairValues[i].Symbol == symbol {
				fv = &beiSnap.FairValues[i]
				break
			}
		}

		if fv == nil || fv.FairValue <= 0 {
			continue // Tanpa Fair Value wajar, Contrarian tidak dapat mengukur deviasi nilai
		}

		// === 1. Deteksi Deviasi Terhadap Acuan Sesi ===
		refPrice := signal.Open
		if refPrice <= 0 {
			refPrice = signal.PreviousPrice
		}
		if refPrice <= 0 {
			refPrice = signal.LastPrice // fallback final
		}

		deviation := math.Abs(float64(signal.LastPrice-refPrice)) / float64(refPrice)
		if deviation < s.cfg.ReferenceDeviationThreshold {
			continue // Tidak terjadi deviasi ekstrim yang memicu kontradiksi
		}

		// === 2. Tentukan Bias Sisi (Mean Reversion ke Fair Value) ===
		var side string
		if float64(signal.LastPrice) <= fv.FairValue*(1.0-s.cfg.DiscountThreshold) {
			side = "buy" // Di bawah harga wajar (Diskon) -> Memicu BUY
		} else if float64(signal.LastPrice) >= fv.FairValue*(1.0+s.cfg.PremiumThreshold) {
			side = "sell" // Di atas harga wajar (Premium) -> Memicu SELL
		}

		if side == "" {
			continue // Harga masih dalam rentang wajar (tidak diskon/premium signifikan)
		}

		// === 3. Konfirmasi Pelemahan Tren / Perlambatan Momentum ===
		// Contrarian tidak ingin menangkap pisau jatuh (falling knife) sebelum pergerakan melambat.
		// Memastikan ShortReturn mendekati nol atau berlawanan arah dengan tren deviasi utama.
		if side == "buy" && signal.ShortReturn < -0.02 {
			// Masih jatuh terlalu tajam, tunda entry
			logger.Debug("Contrarian: skip buy — falling knife pattern detected",
				"bot_id", bot.ExternalBotID,
				"symbol", symbol,
				"short_return", signal.ShortReturn,
			)
			continue
		}
		if side == "sell" && signal.ShortReturn > 0.02 {
			// Masih naik terlalu tajam, tunda entry
			logger.Debug("Contrarian: skip sell — rising star pattern detected",
				"bot_id", bot.ExternalBotID,
				"symbol", symbol,
				"short_return", signal.ShortReturn,
			)
			continue
		}

		// === 4. Fundamental News Block ===
		if side == "buy" {
			hasBadNews := false
			for _, news := range beiSnap.News {
				// Berita harus terkait simbol dan dipublikasikan pada sesi berjalan
				if news.Symbol == symbol && news.Sentiment == "negative" {
					if news.Intensity == "high" || news.Intensity == "extreme" {
						logger.Debug("Contrarian: buy block triggered due to high/extreme negative news",
							"bot_id", bot.ExternalBotID,
							"symbol", symbol,
							"news_title", news.Title,
							"intensity", news.Intensity,
						)
						hasBadNews = true
						break
					}
				}
			}
			if hasBadNews {
				continue // Skip buy order emiten bermasalah fundamental
			}
		}

		// === 5. Penentuan Harga (Pasif / Pasang di Book) ===
		tick := getTickSize(signal.LastPrice, tradingRules.TickSizes)
		var proposedPrice int64

		if side == "buy" {
			// Pasang pasif di bid: LastPrice - (1 atau 2 Ticks)
			proposedPrice = signal.LastPrice - (int64(s.rng.Intn(2))+1)*tick
		} else {
			// Pasang pasif di ask: LastPrice + (1 atau 2 Ticks)
			proposedPrice = signal.LastPrice + (int64(s.rng.Intn(2))+1)*tick
		}

		proposedPrice = common.NormalizeLimitPrice(proposedPrice, signal.LastPrice, tradingRules)
		if proposedPrice <= 0 {
			continue
		}

		// === 6. Hitung Volume Bertahap (Cicilan) ===
		availCash, _, _ := bot.GetCash()
		pos := bot.GetPosition(symbol)

		randomLots := int64(s.rng.Intn(int(s.cfg.MaxLotsPerOrder))) + 1

		var actualLots int64
		if side == "sell" {
			maxSellLots := pos.AvailableShares / lotSize
			if maxSellLots <= 0 {
				continue
			}
			// Cicil maksimal 1/3 dari kepemilikan posisi saat ini
			scaledLots := maxSellLots / 3
			if scaledLots <= 0 {
				scaledLots = 1
			}
			actualLots = randomLots
			if actualLots > scaledLots {
				actualLots = scaledLots
			}
		}

		if side == "buy" {
			affordableLots := common.AffordableLots(availCash, proposedPrice, lotSize, randomLots)
			if affordableLots <= 0 {
				continue
			}
			// Cicil maksimal 1/3 dari buying power cash
			totalAffordable := availCash / (proposedPrice * lotSize)
			scaledLots := totalAffordable / 3
			if scaledLots <= 0 {
				scaledLots = 1
			}
			actualLots = randomLots
			if actualLots > scaledLots {
				actualLots = scaledLots
			}
			// Pastikan budget cash mencukupi setelah volume disesuaikan
			actualLots = common.AffordableLots(availCash, proposedPrice, lotSize, actualLots)
			if actualLots <= 0 {
				continue
			}
		}

		quantityShares := actualLots * lotSize
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

		logger.Debug("Contrarian: decision made",
			"bot_id", bot.ExternalBotID,
			"symbol", symbol,
			"side", side,
			"price", proposedPrice,
			"quantity_shares", quantityShares,
			"deviation_pct", deviation,
			"fair_value", fv.FairValue,
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
	return 1
}
