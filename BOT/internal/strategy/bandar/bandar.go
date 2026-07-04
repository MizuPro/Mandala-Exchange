package bandar

import (
	"context"
	"math/rand"
	"time"

	"github.com/Mandala-Exchange/bot-v2/internal/client/bei"
	"github.com/Mandala-Exchange/bot-v2/internal/client/mats"
	"github.com/Mandala-Exchange/bot-v2/internal/config"
	"github.com/Mandala-Exchange/bot-v2/internal/queue"
	"github.com/Mandala-Exchange/bot-v2/internal/registry"
	"github.com/Mandala-Exchange/bot-v2/internal/strategy/common"
	"github.com/Mandala-Exchange/bot-v2/internal/strategy/rules"
)

type Strategy struct {
	cfg config.BandarConfig
	rng *rand.Rand
}

func New(cfg config.BandarConfig) *Strategy {
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
	if !common.AllowedOrderSegment(segment) {
		return nil
	}

	status := bot.GetStatus()
	if status == "bankrupt" || status == "paused" {
		return nil
	}

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

	ordersCount := bot.GetOrdersThisSession(sessionID)
	if ordersCount >= s.cfg.MaxOrdersPerSession {
		return nil
	}

	tradingRules := common.ParseTradingRules(beiSnap)
	lotSize := rules.GetDefaultLotSize(tradingRules.LotSizes)

	symbols := common.ListedSymbols(beiSnap)
	if len(symbols) == 0 {
		return nil
	}

	var decisions []queue.OrderDecision

	// Bandar secara acak mengevaluasi simbol listed
	shuffledSymbols := make([]string, len(symbols))
	copy(shuffledSymbols, symbols)
	s.rng.Shuffle(len(shuffledSymbols), func(i, j int) {
		shuffledSymbols[i], shuffledSymbols[j] = shuffledSymbols[j], shuffledSymbols[i]
	})

	for _, symbol := range shuffledSymbols {
		var lastPrice int64
		if signal, exists := matsState.GetSignal(symbol); exists && signal.LastPrice > 0 {
			lastPrice = signal.LastPrice
		} else {
			continue // skip jika tidak ada reference price
		}

		var fv *bei.FairValue
		for i := range beiSnap.FairValues {
			if beiSnap.FairValues[i].Symbol == symbol {
				fv = &beiSnap.FairValues[i]
				break
			}
		}

		pos := bot.GetPosition(symbol)
		availCash, _, _ := bot.GetCash()

		// Arah transaksi acak (50% BUY, 50% SELL)
		isBuy := s.rng.Float64() < 0.5

		// Lot size besar khas Bandar (acak antara 20 s/d MaxLotsPerOrder)
		minLots := int64(20)
		if minLots > s.cfg.MaxLotsPerOrder {
			minLots = s.cfg.MaxLotsPerOrder
		}
		var randomLots int64 = minLots
		if s.cfg.MaxLotsPerOrder > minLots {
			randomLots += s.rng.Int63n(s.cfg.MaxLotsPerOrder - minLots + 1)
		}

		if isBuy {
			// BUY dengan Brake Guardrail
			if fv != nil && fv.FairValue > 0 {
				maxBuyPriceAllowed := fv.FairValue * s.cfg.FairValueBrakeMultiplier
				if float64(lastPrice) > maxBuyPriceAllowed {
					// Harga pasar terlalu mahal dari Fair Value, tolak BUY
					continue
				}
			}

			affordableLots := common.AffordableLots(availCash, lastPrice, lotSize, randomLots)
			if affordableLots > 0 {
				decisions = append(decisions, queue.OrderDecision{
					Action:        "place",
					AccountID:     bot.AccountID,
					ClientOrderID: common.ClientOrderID(bot.ExternalBotID, time.Now().UnixNano()),
					Symbol:        symbol,
					Side:          "buy",
					OrderType:     "limit",
					Price:         lastPrice,
					Quantity:      affordableLots * lotSize,
					TTL:           30 * time.Second,
				})
				break // Bandar mengirim maksimal 1 order per tick
			}
		} else {
			// SELL dengan Brake Guardrail
			if fv != nil && fv.FairValue > 0 {
				minSellPriceAllowed := fv.FairValue * (1.0 - s.cfg.BrakeDiscount)
				if float64(lastPrice) < minSellPriceAllowed {
					// Harga pasar terlalu murah dari Fair Value, tolak SELL
					continue
				}
			}

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
					Price:         lastPrice,
					Quantity:      sellLots * lotSize,
					TTL:           30 * time.Second,
				})
				break
			}
		}
	}

	return decisions
}
