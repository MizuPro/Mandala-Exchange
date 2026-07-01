package risk

import (
	"errors"
	"fmt"
	"testing"

	"github.com/Mandala-Exchange/BOT/internal/portfolio"
)

type prices struct {
	price map[string]int64
	lot   map[string]int64
}

func (p prices) LastPriceIDR(symbol string) (int64, bool) {
	v, ok := p.price[symbol]
	return v, ok
}
func (p prices) LotSize(symbol string) (int64, bool) {
	v, ok := p.lot[symbol]
	return v, ok
}

type memoryRepo struct {
	state          State
	bankruptWrites int
}

func (r *memoryRepo) Load(string) (State, error) { return r.state, nil }
func (r *memoryRepo) Save(version int64, s State) (State, error) {
	if version != r.state.Version {
		return State{}, ErrVersionConflict
	}
	s.Version++
	r.state = s
	return s, nil
}
func (r *memoryRepo) MarkBankrupt(version int64, s State) (State, error) {
	r.bankruptWrites++
	return r.Save(version, s)
}

func defaultLimits() Limits {
	return Limits{
		MaxSymbolExposurePct: .30,
		MaxDailyLossPct:      .05,
		MaxWeeklyLossPct:     .15,
		MaxInventoryShares:   1_000,
		MaxLiquidationShares: 100,
	}
}

func TestCheckBuyIncludesReservedPendingAndProposedExposure(t *testing.T) {
	engine := NewEngine(nil, prices{price: map[string]int64{"BBCA": 1_000}, lot: map[string]int64{"BBCA": 100}})
	account := portfolio.Account{
		Cash: portfolio.Cash{AvailableIDR: 800_000},
		Positions: []portfolio.Position{{
			Symbol: "BBCA", AvailableShares: 100, ReservedShares: 50, PendingShares: 50,
		}},
	}
	state := State{Status: StatusActive}
	if err := engine.CheckBuy(state, account, defaultLimits(), BuyRequest{Symbol: "BBCA", PriceIDR: 1_000, QuantityShares: 100}); err != nil {
		t.Fatalf("expected exactly 30%% exposure to pass, got %v", err)
	}
	if err := engine.CheckBuy(state, account, defaultLimits(), BuyRequest{Symbol: "BBCA", PriceIDR: 1_000, QuantityShares: 101}); !errors.Is(err, ErrExposureLimit) {
		t.Fatalf("expected exposure rejection, got %v", err)
	}
}

func TestCheckBuyInventoryAndTerminalStates(t *testing.T) {
	engine := NewEngine(nil, prices{price: map[string]int64{"BBCA": 1_000}, lot: map[string]int64{"BBCA": 100}})
	account := portfolio.Account{Cash: portfolio.Cash{AvailableIDR: 2_000_000}, Positions: []portfolio.Position{{Symbol: "BBCA", AvailableShares: 950}}}
	if err := engine.CheckBuy(State{Status: StatusActive}, account, defaultLimits(), BuyRequest{Symbol: "BBCA", PriceIDR: 1_000, QuantityShares: 100}); !errors.Is(err, ErrInventoryLimit) {
		t.Fatalf("expected inventory rejection, got %v", err)
	}
	if err := engine.CheckBuy(State{Status: StatusLiquidating}, account, defaultLimits(), BuyRequest{Symbol: "BBCA", PriceIDR: 1_000, QuantityShares: 1}); !errors.Is(err, ErrLiquidationOnly) {
		t.Fatalf("expected liquidation-only rejection, got %v", err)
	}
	if err := engine.CheckBuy(State{Status: StatusBankrupt}, account, defaultLimits(), BuyRequest{Symbol: "BBCA", PriceIDR: 1_000, QuantityShares: 1}); !errors.Is(err, ErrBankrupt) {
		t.Fatalf("expected bankrupt rejection, got %v", err)
	}
}

func TestDailyLossUsesSessionInstanceAndResetsOnRollover(t *testing.T) {
	repo := &memoryRepo{}
	engine := NewEngine(repo, prices{price: map[string]int64{}, lot: map[string]int64{}})
	limits := defaultLimits()
	account := portfolio.Account{AccountID: "acc", Cash: portfolio.Cash{AvailableIDR: 100_000}}
	state := State{BotID: "bot", AccountID: "acc"}

	first, err := engine.Evaluate(state, account, limits, "11111111-1111-1111-1111-111111111111", 10)
	if err != nil {
		t.Fatal(err)
	}
	account.Cash.AvailableIDR = 94_999
	breached, err := engine.Evaluate(first.State, account, limits, "11111111-1111-1111-1111-111111111111", 10)
	if err != nil {
		t.Fatal(err)
	}
	if breached.State.Status != StatusDisabled || breached.DailyLossIDR != 5_001 {
		t.Fatalf("daily loss not enforced: %+v", breached)
	}

	// A new session resets the daily baseline, but a loss-disabled state remains disabled
	// until explicit audited admin reactivation.
	rolled, err := engine.Evaluate(breached.State, account, limits, "22222222-2222-2222-2222-222222222222", 11)
	if err != nil {
		t.Fatal(err)
	}
	if rolled.DailyLossIDR != 0 || rolled.State.DailyBaselineIDR != 94_999 || rolled.State.Status != StatusDisabled {
		t.Fatalf("unexpected rollover state: %+v", rolled)
	}
}

func TestWeeklyBaselineResetsEveryFiveCompletedSessions(t *testing.T) {
	repo := &memoryRepo{}
	engine := NewEngine(repo, prices{price: map[string]int64{}, lot: map[string]int64{}})
	limits := defaultLimits()
	account := portfolio.Account{AccountID: "acc", Cash: portfolio.Cash{AvailableIDR: 100_000}}
	result, err := engine.Evaluate(State{BotID: "bot", AccountID: "acc"}, account, limits, "00000000-0000-0000-0000-000000000001", 20)
	if err != nil {
		t.Fatal(err)
	}
	for day := 21; day <= 24; day++ {
		account.Cash.AvailableIDR--
		result, err = engine.Evaluate(result.State, account, limits, sessionID(day), day)
		if err != nil {
			t.Fatal(err)
		}
		if result.State.WeekStartDayIndex != 20 {
			t.Fatalf("weekly baseline reset early on day %d", day)
		}
	}
	account.Cash.AvailableIDR = 90_000
	result, err = engine.Evaluate(result.State, account, limits, sessionID(25), 25)
	if err != nil {
		t.Fatal(err)
	}
	if result.State.WeekStartDayIndex != 25 || result.State.WeeklyBaselineIDR != 90_000 || result.WeeklyLossIDR != 0 {
		t.Fatalf("weekly baseline did not reset: %+v", result)
	}
}

func TestOutOfCashLiquidatesByLotAndBankruptcyIsTerminal(t *testing.T) {
	repo := &memoryRepo{}
	engine := NewEngine(repo, prices{
		price: map[string]int64{"BBCA": 1_000},
		lot:   map[string]int64{"BBCA": 100},
	})
	limits := defaultLimits()
	state := State{BotID: "bot", AccountID: "acc"}
	account := portfolio.Account{
		AccountID: "acc",
		Cash:      portfolio.Cash{},
		Positions: []portfolio.Position{{Symbol: "BBCA", AvailableShares: 250}},
	}
	result, err := engine.Evaluate(state, account, limits, "11111111-1111-1111-1111-111111111111", 1)
	if err != nil {
		t.Fatal(err)
	}
	if result.State.Status != StatusLiquidating || len(result.LiquidationOrders) != 1 || result.LiquidationOrders[0].QuantityShares != 100 {
		t.Fatalf("expected bounded lot liquidation: %+v", result)
	}
	repeated, err := engine.Evaluate(result.State, account, limits, "11111111-1111-1111-1111-111111111111", 1)
	if err != nil {
		t.Fatal(err)
	}
	if repeated.Changed || repeated.State.Version != result.State.Version {
		t.Fatalf("unchanged liquidation must be idempotent: first=%+v repeated=%+v", result.State, repeated.State)
	}

	account.Positions = nil
	result, err = engine.Evaluate(result.State, account, limits, "11111111-1111-1111-1111-111111111111", 1)
	if err != nil {
		t.Fatal(err)
	}
	if result.State.Status != StatusBankrupt || repo.bankruptWrites != 1 {
		t.Fatalf("expected persisted bankruptcy: %+v writes=%d", result, repo.bankruptWrites)
	}
	again, err := engine.Evaluate(result.State, account, limits, "22222222-2222-2222-2222-222222222222", 2)
	if err != nil {
		t.Fatal(err)
	}
	if again.State.Status != StatusBankrupt || repo.bankruptWrites != 1 {
		t.Fatalf("bankrupt state must be terminal and idempotent: %+v writes=%d", again, repo.bankruptWrites)
	}
}

func TestRejectsMissingPriceAndRegressedSession(t *testing.T) {
	engine := NewEngine(nil, prices{price: map[string]int64{}, lot: map[string]int64{}})
	account := portfolio.Account{Cash: portfolio.Cash{AvailableIDR: 1}, Positions: []portfolio.Position{{Symbol: "BBCA", AvailableShares: 1}}}
	if _, err := engine.Evaluate(State{}, account, defaultLimits(), "one", 1); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("expected missing price error, got %v", err)
	}

	account.Positions = nil
	state := State{SessionInstanceID: "new", VirtualDayIndex: 2, DailyBaselineIDR: 1, WeeklyBaselineIDR: 1}
	if _, err := engine.Evaluate(state, account, defaultLimits(), "old", 1); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("expected regressed session error, got %v", err)
	}
}

func sessionID(day int) string {
	return fmt.Sprintf("00000000-0000-0000-0000-%012d", day)
}
