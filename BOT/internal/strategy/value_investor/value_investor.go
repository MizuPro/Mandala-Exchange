package valueinvestor

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
	cfg config.ValueInvestorConfig
	rng *rand.Rand
}

func New(cfg config.ValueInvestorConfig) *Strategy {
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

	// Maksimal order per sesi check
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

	for _, symbol := range symbols {
		// Cari Fair Value
		var fv *bei.FairValue
		for i := range beiSnap.FairValues {
			if beiSnap.FairValues[i].Symbol == symbol {
				fv = &beiSnap.FairValues[i]
				break
			}
		}
		if fv == nil || fv.FairValue <= 0 {
			continue
		}

		segment := matsState.GetSessionSegment()
		if matsState.IsWarmingUp(symbol) && segment != "opening_auction" {
			continue
		}

		// Cari Last Price dari matsState
		var lastPrice int64
		if signal, exists := matsState.GetSignal(symbol); exists && signal.LastPrice > 0 {
			lastPrice = signal.LastPrice
		} else if segment == "opening_auction" {
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

		pos := bot.GetPosition(symbol)
		availCash, _, _ := bot.GetCash()

		// A. Kriteria Beli (Discount / Margin of Safety)
		if float64(lastPrice) <= fv.FairValue*(1.0-s.cfg.DiscountThreshold) {
			proposedLots := s.cfg.MaxLotsPerOrder
			affordableLots := common.AffordableLots(availCash, lastPrice, lotSize, proposedLots)
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
				// Hanya mengirim maksimal 1 order per sesi/tick untuk value investor
				break
			}
		}

		// B. Kriteria Jual (Premium)
		if pos.AvailableShares > 0 && float64(lastPrice) >= fv.FairValue*(1.0+s.cfg.PremiumThreshold) {
			maxSellLots := pos.AvailableShares / lotSize
			sellLots := s.cfg.MaxLotsPerOrder
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
