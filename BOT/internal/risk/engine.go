// Package risk implements preventive order risk checks and the persistent
// liquidation/bankruptcy lifecycle. Sekuritas remains the accounting authority;
// this package only rejects unsafe BOT decisions and reacts to reconciled cache data.
package risk

import (
	"errors"
	"fmt"
	"math/big"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/Mandala-Exchange/BOT/internal/portfolio"
)

var (
	ErrInvalidInput       = errors.New("invalid risk input")
	ErrExposureLimit      = errors.New("max symbol exposure exceeded")
	ErrInventoryLimit     = errors.New("inventory limit exceeded")
	ErrLossLimit          = errors.New("loss limit breached")
	ErrLiquidationOnly    = errors.New("bot is in liquidation-only mode")
	ErrBankrupt           = errors.New("bot is permanently bankrupt")
	ErrSessionUnavailable = errors.New("session instance unavailable")
)

type Status string

const (
	StatusActive      Status = "active"
	StatusLiquidating Status = "liquidating"
	StatusDisabled    Status = "disabled"
	StatusBankrupt    Status = "bankrupt"
)

type Limits struct {
	MaxSymbolExposurePct float64
	MaxDailyLossPct      float64
	MaxWeeklyLossPct     float64
	MaxInventoryShares   int64
	MaxLiquidationShares int64
}

func (l Limits) Validate() error {
	if l.MaxSymbolExposurePct <= 0 || l.MaxSymbolExposurePct > 1 ||
		l.MaxDailyLossPct <= 0 || l.MaxDailyLossPct > 1 ||
		l.MaxWeeklyLossPct <= 0 || l.MaxWeeklyLossPct > 1 {
		return ErrInvalidInput
	}
	if l.MaxWeeklyLossPct < l.MaxDailyLossPct || l.MaxInventoryShares < 0 || l.MaxLiquidationShares < 0 {
		return ErrInvalidInput
	}
	return nil
}

type State struct {
	BotID             string
	AccountID         string
	Status            Status
	SessionInstanceID string
	VirtualDayIndex   int
	DailyBaselineIDR  int64
	WeeklyBaselineIDR int64
	WeekStartDayIndex int
	LastEquityIDR     int64
	DisabledReason    string
	Version           int64
}

type Repository interface {
	Load(botID string) (State, error)
	Save(previousVersion int64, state State) (State, error)
	MarkBankrupt(previousVersion int64, state State) (State, error)
}

type PriceProvider interface {
	LastPriceIDR(symbol string) (int64, bool)
	LotSize(symbol string) (int64, bool)
}

type BuyRequest struct {
	Symbol         string
	PriceIDR       int64
	QuantityShares int64
}

type LiquidationOrder struct {
	Symbol         string
	QuantityShares int64
}

type Assessment struct {
	State             State
	EquityIDR         int64
	DailyLossIDR      int64
	WeeklyLossIDR     int64
	LiquidationOrders []LiquidationOrder
	Changed           bool
}

type Engine struct {
	mu     sync.Mutex
	repo   Repository
	prices PriceProvider
}

func NewEngine(repo Repository, prices PriceProvider) *Engine {
	return &Engine{repo: repo, prices: prices}
}

// CheckBuy performs the preventive check immediately before a new buy is queued.
// Exposure includes available, reserved, and pending shares plus the proposed buy.
func (e *Engine) CheckBuy(state State, account portfolio.Account, limits Limits, req BuyRequest) error {
	if err := limits.Validate(); err != nil {
		return err
	}
	switch state.Status {
	case StatusBankrupt:
		return ErrBankrupt
	case StatusLiquidating:
		return ErrLiquidationOnly
	case StatusDisabled:
		return ErrLossLimit
	}
	if strings.TrimSpace(req.Symbol) == "" || req.PriceIDR <= 0 || req.QuantityShares <= 0 {
		return ErrInvalidInput
	}
	if e.prices == nil {
		return fmt.Errorf("%w: price provider unavailable", ErrInvalidInput)
	}
	equity, err := e.equity(account)
	if err != nil || equity <= 0 {
		return fmt.Errorf("%w: cannot value portfolio", ErrInvalidInput)
	}
	currentShares := totalShares(account, req.Symbol)
	if limits.MaxInventoryShares > 0 && currentShares+req.QuantityShares > limits.MaxInventoryShares {
		return ErrInventoryLimit
	}
	lastPrice, ok := e.prices.LastPriceIDR(req.Symbol)
	if !ok || lastPrice <= 0 {
		return fmt.Errorf("%w: missing last price for %s", ErrInvalidInput, req.Symbol)
	}
	exposure := new(big.Int).Mul(big.NewInt(currentShares), big.NewInt(lastPrice))
	exposure.Add(exposure, new(big.Int).Mul(big.NewInt(req.QuantityShares), big.NewInt(req.PriceIDR)))
	if exceedsRatio(exposure, equity, limits.MaxSymbolExposurePct) {
		return ErrExposureLimit
	}
	return nil
}

// Evaluate applies session-based loss limits and the insolvency lifecycle.
// One simulated week is exactly five completed virtual-day indexes.
func (e *Engine) Evaluate(state State, account portfolio.Account, limits Limits, sessionID string, dayIndex int) (Assessment, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if err := limits.Validate(); err != nil {
		return Assessment{}, err
	}
	if sessionID == "" || dayIndex < 0 {
		return Assessment{}, ErrSessionUnavailable
	}
	if e.prices == nil {
		return Assessment{}, fmt.Errorf("%w: price provider unavailable", ErrInvalidInput)
	}
	if state.Status == StatusBankrupt {
		return Assessment{State: state, EquityIDR: state.LastEquityIDR}, nil
	}
	equity, err := e.equity(account)
	if err != nil {
		return Assessment{}, err
	}
	previousVersion := state.Version
	changed := false
	if state.SessionInstanceID == "" {
		state.SessionInstanceID = sessionID
		state.VirtualDayIndex = dayIndex
		state.DailyBaselineIDR = equity
		state.WeeklyBaselineIDR = equity
		state.WeekStartDayIndex = dayIndex
		changed = true
	} else if state.SessionInstanceID != sessionID {
		if dayIndex <= state.VirtualDayIndex {
			return Assessment{}, fmt.Errorf("%w: virtual day must increase on rollover", ErrInvalidInput)
		}
		state.SessionInstanceID = sessionID
		state.VirtualDayIndex = dayIndex
		state.DailyBaselineIDR = equity
		if dayIndex-state.WeekStartDayIndex >= 5 {
			state.WeeklyBaselineIDR = equity
			state.WeekStartDayIndex = dayIndex
		}
		changed = true
	}
	if state.DailyBaselineIDR == 0 {
		state.DailyBaselineIDR = equity
		changed = true
	}
	if state.WeeklyBaselineIDR == 0 {
		state.WeeklyBaselineIDR = equity
		state.WeekStartDayIndex = dayIndex
		changed = true
	}
	dailyLoss := positiveLoss(state.DailyBaselineIDR, equity)
	weeklyLoss := positiveLoss(state.WeeklyBaselineIDR, equity)
	if exceeds(dailyLoss, state.DailyBaselineIDR, limits.MaxDailyLossPct) ||
		exceeds(weeklyLoss, state.WeeklyBaselineIDR, limits.MaxWeeklyLossPct) {
		if state.Status != StatusDisabled || state.DisabledReason != "loss_limit_breached" {
			state.Status = StatusDisabled
			state.DisabledReason = "loss_limit_breached"
			changed = true
		}
	}

	orders, canBuyCheapest := e.liquidationOrders(account, limits)
	hasInventory := hasShares(account)
	if account.Cash.AvailableIDR <= 0 && !hasInventory {
		if state.Status != StatusBankrupt || state.DisabledReason != "total_insolvency" {
			state.Status = StatusBankrupt
			state.DisabledReason = "total_insolvency"
			changed = true
		}
	} else if state.Status != StatusDisabled && !canBuyCheapest && hasInventory {
		if state.Status != StatusLiquidating || state.DisabledReason != "out_of_cash" {
			state.Status = StatusLiquidating
			state.DisabledReason = "out_of_cash"
			changed = true
		}
	} else if state.Status == StatusLiquidating && canBuyCheapest {
		state.Status = StatusActive
		state.DisabledReason = ""
		orders = nil
		changed = true
	}
	state.LastEquityIDR = equity
	if state.Status == "" {
		state.Status = StatusActive
		changed = true
	}

	if e.repo != nil && changed {
		if state.Status == StatusBankrupt {
			state, err = e.repo.MarkBankrupt(previousVersion, state)
		} else {
			state, err = e.repo.Save(previousVersion, state)
		}
		if err != nil {
			return Assessment{}, err
		}
	}
	return Assessment{State: state, EquityIDR: equity, DailyLossIDR: dailyLoss, WeeklyLossIDR: weeklyLoss, LiquidationOrders: orders, Changed: changed}, nil
}

func (e *Engine) equity(account portfolio.Account) (int64, error) {
	total := big.NewInt(account.Cash.TotalIDR())
	for _, p := range account.Positions {
		price, ok := e.prices.LastPriceIDR(p.Symbol)
		if !ok || price <= 0 {
			return 0, fmt.Errorf("%w: missing last price for %s", ErrInvalidInput, p.Symbol)
		}
		value := new(big.Int).Mul(big.NewInt(p.AvailableShares+p.ReservedShares+p.PendingShares), big.NewInt(price))
		total.Add(total, value)
	}
	if !total.IsInt64() {
		return 0, fmt.Errorf("%w: equity overflow", ErrInvalidInput)
	}
	return total.Int64(), nil
}

func (e *Engine) liquidationOrders(account portfolio.Account, limits Limits) ([]LiquidationOrder, bool) {
	cheapestLotCost := int64(0)
	var result []LiquidationOrder
	for _, p := range account.Positions {
		price, priceOK := e.prices.LastPriceIDR(p.Symbol)
		lot, lotOK := e.prices.LotSize(p.Symbol)
		if priceOK && lotOK && price > 0 && lot > 0 {
			cost := price * lot
			if cheapestLotCost == 0 || cost < cheapestLotCost {
				cheapestLotCost = cost
			}
		}
		if p.AvailableShares <= 0 || !lotOK || lot <= 0 {
			continue
		}
		qty := p.AvailableShares - p.AvailableShares%lot
		if limits.MaxLiquidationShares > 0 && qty > limits.MaxLiquidationShares {
			qty = limits.MaxLiquidationShares - limits.MaxLiquidationShares%lot
		}
		if qty > 0 {
			result = append(result, LiquidationOrder{Symbol: p.Symbol, QuantityShares: qty})
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Symbol < result[j].Symbol })
	return result, cheapestLotCost > 0 && account.Cash.AvailableIDR >= cheapestLotCost
}

func totalShares(account portfolio.Account, symbol string) int64 {
	for _, p := range account.Positions {
		if p.Symbol == symbol {
			return p.AvailableShares + p.ReservedShares + p.PendingShares
		}
	}
	return 0
}

func hasShares(account portfolio.Account) bool {
	for _, p := range account.Positions {
		if p.AvailableShares+p.ReservedShares+p.PendingShares > 0 {
			return true
		}
	}
	return false
}

func positiveLoss(baseline, current int64) int64 {
	if current >= baseline {
		return 0
	}
	return baseline - current
}

func exceeds(loss, baseline int64, pct float64) bool {
	if baseline <= 0 {
		return false
	}
	return exceedsRatio(big.NewInt(loss), baseline, pct)
}

func exceedsRatio(value *big.Int, baseline int64, pct float64) bool {
	ratio, ok := new(big.Rat).SetString(strconv.FormatFloat(pct, 'f', -1, 64))
	if !ok {
		return true
	}
	limit := new(big.Rat).Mul(new(big.Rat).SetInt64(baseline), ratio)
	return new(big.Rat).SetInt(value).Cmp(limit) > 0
}
