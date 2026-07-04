package common

import (
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/Mandala-Exchange/bot-v2/internal/client/bei"
	"github.com/Mandala-Exchange/bot-v2/internal/strategy/rules"
)

type TradingRules struct {
	TickSizes  []rules.TickSizeRule
	LotSizes   []rules.LotSizeRule
	PriceBands []rules.PriceBandRule
	AutoReject []rules.AutoRejectionRule
}

func ParseTradingRules(snapshot bei.Snapshot) TradingRules {
	var selected *bei.TradingRuleProfile
	for index := range snapshot.Rules {
		if snapshot.Rules[index].IsDefault {
			selected = &snapshot.Rules[index]
			break
		}
	}
	if selected == nil && len(snapshot.Rules) > 0 {
		selected = &snapshot.Rules[0]
	}
	if selected == nil {
		return TradingRules{}
	}
	return TradingRules{
		TickSizes:  rules.ParseTickSizeRules(selected.TickSizeRules),
		LotSizes:   rules.ParseLotSizeRules(selected.LotSizeRules),
		PriceBands: rules.ParsePriceBandRules(selected.PriceBandRules),
		AutoReject: rules.ParseAutoRejectionRules(selected.AutoRejectionRules),
	}
}

func NormalizeLimitPrice(proposed, reference int64, tradingRules TradingRules) int64 {
	price := rules.SnapToTickSize(proposed, tradingRules.TickSizes)
	price = rules.ClampToPriceBand(price, reference, tradingRules.PriceBands)
	return rules.SnapToTickSize(price, tradingRules.TickSizes)
}

func ListedSymbols(snapshot bei.Snapshot) []string {
	symbols := make([]string, 0, len(snapshot.Securities))
	for _, security := range snapshot.Securities {
		if security.Status == "listed" {
			symbols = append(symbols, security.Symbol)
		}
	}
	return symbols
}

func SessionID(snapshot bei.Snapshot) string {
	if snapshot.Session != nil && snapshot.Session.ID != "" {
		return snapshot.Session.ID
	}
	return time.Now().Format("2006-01-02")
}

func AllowedOrderSegment(segment string) bool {
	switch segment {
	case "opening_auction", "continuous", "closing_auction":
		return true
	default:
		return false
	}
}

func AffordableLots(availableCash, price, lotSize, desiredLots int64) int64 {
	if availableCash <= 0 || price <= 0 || lotSize <= 0 || desiredLots <= 0 {
		return 0
	}
	affordable := availableCash / (price * lotSize)
	if affordable < desiredLots {
		return affordable
	}
	return desiredLots
}

func ClientOrderID(botID string, sequence int64) string {
	return fmt.Sprintf("bot:%s:%s:%d", botID, uuid.NewString(), sequence)
}
