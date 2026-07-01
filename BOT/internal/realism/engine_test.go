package realism

import (
	"testing"
	"time"

	"github.com/Mandala-Exchange/BOT/internal/config"
	"github.com/Mandala-Exchange/BOT/internal/marketrules"
	"github.com/Mandala-Exchange/BOT/internal/session"
	"github.com/google/uuid"
)

type testClock struct {
	instance *session.SessionInstance
	progress float64
	ratio    float64
}

func (c testClock) GetInstance() *session.SessionInstance { copy := *c.instance; return &copy }
func (c testClock) SessionProgress() float64              { return c.progress }
func (c testClock) VirtualToRealDelay(d time.Duration) time.Duration {
	return time.Duration(float64(d) * c.ratio)
}

func testResolver(t *testing.T) *marketrules.SnapshotResolver {
	t.Helper()
	securities := `[{"symbol":"BBCA","board":"main","status":"listed","previous_close":1000,"last":1000}]`
	rules := `[{"board":"main","lot_size_rules":[{"lot_size":100}],"tick_size_rules":[{"min_price":1,"max_price":2000,"tick_size":5}],"price_band_rules":[{"ara_percent":0.2,"arb_percent":0.2}]}]`
	fees := `{"broker_buy_rate":0.001,"broker_sell_rate":0.001,"settlement_fee_rate":0.0001,"guarantee_fund_rate":0.0001,"vat_rate":0.11,"sell_tax_rate":0.001}`
	resolver, err := marketrules.NewSnapshotResolver(
		[]byte(securities), []byte(rules), []byte(fees),
		time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC),
	)
	if err != nil {
		t.Fatal(err)
	}
	return resolver
}

func activeClock(progress, ratio float64) testClock {
	return testClock{
		instance: &session.SessionInstance{
			InstanceID: uuid.New(), VirtualDayIndex: 1,
			VirtualDurationSecs: 21600, RealDurationSecs: 1800,
			Status: session.StateContinuous,
		},
		progress: progress, ratio: ratio,
	}
}

func fixedHuman() config.HumanConfig {
	h := config.DefaultHumanConfig()
	h.ReactionDelayVirtualSeconds = config.Distribution{Type: "fixed", Min: 30, Max: 30}
	h.OverreactionMultiplier = config.Distribution{Type: "fixed", Min: 2, Max: 2}
	return h
}

func fixedActivity() config.ActivityConfig {
	a := config.DefaultActivityConfig()
	a.MorningMultiplier = config.Distribution{Type: "fixed", Min: 4, Max: 4}
	a.MiddayMultiplier = config.Distribution{Type: "fixed", Min: 1, Max: 1}
	a.ClosingMultiplier = config.Distribution{Type: "fixed", Min: 3, Max: 3}
	return a
}

func TestUCurveAndCompressedVirtualDelay(t *testing.T) {
	engine := New(10)
	human := fixedHuman()
	human.PriceFatFingerProbability = 0
	human.DecisionAbortProbability = 0
	human.OverreactionProbability = 0
	human.InactiveSessionProbability = 0
	intent := OrderIntent{BotID: "bot-1", Symbol: "BBCA", Side: "buy", PriceIDR: 1000, QuantityShares: 100}

	tests := []struct {
		name                 string
		progress, multiplier float64
		wantDelay            time.Duration
	}{
		{"morning", 0.10, 4, 625 * time.Millisecond},
		{"midday", 0.50, 1, 2500 * time.Millisecond},
		{"closing", 0.90, 3, time.Second * 5 / 6},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			plan, err := engine.PlanDecision(activeClock(tc.progress, 1.0/12.0), testResolver(t), human, fixedActivity(), intent)
			if err != nil {
				t.Fatal(err)
			}
			if plan.ActivityMultiplier != tc.multiplier || plan.ReactionDelay != tc.wantDelay {
				t.Fatalf("multiplier/delay = %v/%v, want %v/%v", plan.ActivityMultiplier, plan.ReactionDelay, tc.multiplier, tc.wantDelay)
			}
		})
	}
}

func TestImperfectionsRemainRuleValidAndBounded(t *testing.T) {
	engine := New(2)
	human := fixedHuman()
	human.PriceFatFingerProbability = 1
	human.PriceFatFingerRangeTicks = 3
	human.DecisionAbortProbability = 0
	human.OverreactionProbability = 1
	human.InactiveSessionProbability = 0

	plan, err := engine.PlanDecision(activeClock(0.5, 1), testResolver(t), human, fixedActivity(),
		OrderIntent{BotID: "bot-1", Symbol: "BBCA", Side: "buy", PriceIDR: 1195, QuantityShares: 150})
	if err != nil {
		t.Fatal(err)
	}
	if !plan.FatFingerApplied || !plan.OverreactionApplied {
		t.Fatal("expected both bounded imperfections")
	}
	if plan.Order.PriceIDR%5 != 0 || plan.Order.PriceIDR < 800 || plan.Order.PriceIDR > 1200 {
		t.Fatalf("fat finger produced invalid price %d", plan.Order.PriceIDR)
	}
	if plan.Order.QuantityShares != 300 {
		t.Fatalf("overreaction quantity = %d, want aligned 300", plan.Order.QuantityShares)
	}
}

func TestAbortInactiveAndSessionGuards(t *testing.T) {
	resolver := testResolver(t)
	intent := OrderIntent{BotID: "bot-1", Symbol: "BBCA", Side: "sell", PriceIDR: 1000, QuantityShares: 100}

	human := fixedHuman()
	human.InactiveSessionProbability = 1
	plan, err := New(1).PlanDecision(activeClock(0.5, 1), resolver, human, fixedActivity(), intent)
	if err != nil || !plan.Abort || !plan.InactiveSession {
		t.Fatalf("inactive session plan = %+v, err=%v", plan, err)
	}

	human.InactiveSessionProbability = 0
	human.DecisionAbortProbability = 1
	plan, err = New(1).PlanDecision(activeClock(0.5, 1), resolver, human, fixedActivity(), intent)
	if err != nil || !plan.Abort || plan.InactiveSession {
		t.Fatalf("abort plan = %+v, err=%v", plan, err)
	}

	clock := activeClock(0.5, 1)
	clock.instance.Status = session.StateClosed
	if _, err := New(1).PlanDecision(clock, resolver, human, fixedActivity(), intent); err != ErrInactiveSegment {
		t.Fatalf("closed segment error = %v", err)
	}
}

func TestDeterministicSeedProducesSamePlan(t *testing.T) {
	human := config.DefaultHumanConfig()
	activity := config.DefaultActivityConfig()
	clock := activeClock(0.2, 1.0/12.0)
	intent := OrderIntent{BotID: "bot-1", Symbol: "BBCA", Side: "buy", PriceIDR: 1000, QuantityShares: 200}
	first, err := New(99).PlanDecision(clock, testResolver(t), human, activity, intent)
	if err != nil {
		t.Fatal(err)
	}
	second, err := New(99).PlanDecision(clock, testResolver(t), human, activity, intent)
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatalf("same seed produced different plans: %+v vs %+v", first, second)
	}
}
