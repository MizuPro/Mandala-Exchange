package indextracker

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
	cfg config.IndexTrackerConfig
	rng *rand.Rand
}

func New(cfg config.IndexTrackerConfig) *Strategy {
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
	nSymbols := int64(len(symbols))
	if nSymbols == 0 {
		return nil
	}

	// Hitung Total Portfolio Value
	availCash, _, _ := bot.GetCash()
	var totalPortfolioValue int64 = availCash

	prices := make(map[string]int64)
	for _, symbol := range symbols {
		if signal, exists := matsState.GetSignal(symbol); exists && signal.LastPrice > 0 {
			prices[symbol] = signal.LastPrice
			pos := bot.GetPosition(symbol)
			totalPortfolioValue += pos.AvailableShares * signal.LastPrice
		}
	}

	// Target nilai portofolio per emiten
	targetValuePerSymbol := totalPortfolioValue / nSymbols

	var decisions []queue.OrderDecision

	for _, symbol := range symbols {
		price, exists := prices[symbol]
		if !exists || price <= 0 {
			continue
		}

		pos := bot.GetPosition(symbol)
		currentValue := pos.AvailableShares * price

		// A. Kekurangan Alokasi (Under-allocated) -> BUY
		if currentValue < targetValuePerSymbol {
			diff := targetValuePerSymbol - currentValue
			neededShares := diff / price
			neededLots := neededShares / lotSize

			if neededLots > s.cfg.MaxLotsPerOrder {
				neededLots = s.cfg.MaxLotsPerOrder
			}

			affordableLots := common.AffordableLots(availCash, price, lotSize, neededLots)
			if affordableLots > 0 {
				decisions = append(decisions, queue.OrderDecision{
					Action:        "place",
					AccountID:     bot.AccountID,
					ClientOrderID: common.ClientOrderID(bot.ExternalBotID, time.Now().UnixNano()),
					Symbol:        symbol,
					Side:          "buy",
					OrderType:     "limit",
					Price:         price,
					Quantity:      affordableLots * lotSize,
					TTL:           30 * time.Second,
				})
				// Hanya mengirim maksimal 1 keputusan per sesi
				break
			}
		}

		// B. Kelebihan Alokasi (Over-allocated) -> SELL
		if currentValue > targetValuePerSymbol {
			diff := currentValue - targetValuePerSymbol
			extraShares := diff / price
			extraLots := extraShares / lotSize

			if extraLots > s.cfg.MaxLotsPerOrder {
				extraLots = s.cfg.MaxLotsPerOrder
			}

			maxSellLots := pos.AvailableShares / lotSize
			sellLots := extraLots
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
					Price:         price,
					Quantity:      sellLots * lotSize,
					TTL:           30 * time.Second,
				})
				break
			}
		}
	}

	return decisions
}
