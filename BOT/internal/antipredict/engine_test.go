package antipredict

import (
	"math"
	"math/rand"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestHMACSessionSeedBoundariesAndDeterminism(t *testing.T) {
	seeder, err := NewSeeder([]byte("0123456789abcdef0123456789abcdef"), "bot-v1")
	if err != nil {
		t.Fatal(err)
	}
	session := uuid.New()
	first, _ := seeder.SessionSeed("bot-1", session, 3)
	second, _ := seeder.SessionSeed("bot-1", session, 3)
	otherSession, _ := seeder.SessionSeed("bot-1", uuid.New(), 3)
	otherConfig, _ := seeder.SessionSeed("bot-1", session, 4)
	if first != second || first == otherSession || first == otherConfig {
		t.Fatalf("invalid seed isolation: %d %d %d %d", first, second, otherSession, otherConfig)
	}
	if _, err := NewSeeder([]byte("short"), "bot-v1"); err == nil {
		t.Fatal("weak secret accepted")
	}
}

func TestPopulationRotationMaintainsRatiosAndStatefulBots(t *testing.T) {
	ratios := map[string]float64{"noise": .40, "momentum": .30, "contrarian": .15, "market_maker": .05, "value": .05, "index": .02, "event": .02, "bandar": .01}
	var registry []Bot
	for strategy, ratio := range ratios {
		for index := 0; index < int(ratio*2000); index++ {
			registry = append(registry, Bot{ID: strategy + "-" + string(rune(index+1000)), Strategy: strategy})
		}
	}
	registry[0].HasState = true
	first, err := Rotate(registry, 500, ratios, 99)
	if err != nil {
		t.Fatal(err)
	}
	second, _ := Rotate(registry, 500, ratios, 99)
	if !reflect.DeepEqual(first, second) {
		t.Fatal("same seed changed population")
	}
	counts := map[string]int{}
	statefulFound := false
	for _, bot := range first {
		counts[bot.Strategy]++
		statefulFound = statefulFound || bot.ID == registry[0].ID
	}
	if !statefulFound {
		t.Fatal("stateful bot rotated out without cleanup")
	}
	for strategy, ratio := range ratios {
		if math.Abs(float64(counts[strategy])/500-ratio) > .02 {
			t.Fatalf("%s ratio outside tolerance: %d", strategy, counts[strategy])
		}
	}
}

func TestBoundedDriftMeanReversion(t *testing.T) {
	rng := rand.New(rand.NewSource(4))
	previous := 120.0
	for range 100 {
		value, err := Drift(100, 90, 110, .10, .30, previous, rng)
		if err != nil {
			t.Fatal(err)
		}
		if value < 90 || value > 110 {
			t.Fatalf("drift escaped bounds: %f", value)
		}
		previous = value
	}
}

func TestSignalConfirmationHysteresisAndRandomCooldown(t *testing.T) {
	gate := NewSignalGate()
	gate.MinimumTrades = 3
	gate.MinimumPersistence = 15 * time.Second
	gate.RequireVolume = true
	gate.EntryThreshold = .015
	gate.ExitThreshold = .012
	gate.CooldownMin = 10 * time.Minute
	gate.CooldownMax = 40 * time.Minute
	rng := rand.New(rand.NewSource(8))
	now := time.Now()
	active, err := gate.Evaluate("bot-1", now, PublicSignals{TradeCount: 1, Persistence: time.Minute, VolumeConfirmed: true, PriceChangeRatio: .02}, rng)
	if err != nil || active {
		t.Fatal("single trade incorrectly confirmed signal")
	}
	active, _ = gate.Evaluate("bot-1", now, PublicSignals{TradeCount: 3, Persistence: 15 * time.Second, VolumeConfirmed: true, PriceChangeRatio: .016}, rng)
	if !active {
		t.Fatal("confirmed entry rejected")
	}
	active, _ = gate.Evaluate("bot-1", now, PublicSignals{PriceChangeRatio: .014}, rng)
	if !active {
		t.Fatal("hysteresis did not retain active signal")
	}
	active, _ = gate.Evaluate("bot-1", now, PublicSignals{PriceChangeRatio: .011}, rng)
	if active {
		t.Fatal("exit threshold did not deactivate")
	}
	active, _ = gate.Evaluate("bot-1", now.Add(9*time.Minute), PublicSignals{TradeCount: 9, Persistence: time.Hour, VolumeConfirmed: true, PriceChangeRatio: .03}, rng)
	if active {
		t.Fatal("random cooldown minimum was bypassed")
	}
}

func TestConditionalBandarTransitionVariesAcrossWindow(t *testing.T) {
	var transitioned, held int
	for seed := int64(0); seed < 100; seed++ {
		ok, err := CanTransitionBandar(BandarEligibility{
			Sessions: 12, MinimumSessions: 8, MaximumPatience: 18,
			TargetCompletion: .85, MinimumCompletion: .80,
			LiquidityOK: true, PublicSentimentOK: true, StochasticProbability: .5,
		}, rand.New(rand.NewSource(seed)))
		if err != nil {
			t.Fatal(err)
		}
		if ok {
			transitioned++
		} else {
			held++
		}
	}
	if transitioned == 0 || held == 0 {
		t.Fatalf("transition became exact/predictable: transitioned=%d held=%d", transitioned, held)
	}
	ok, _ := CanTransitionBandar(BandarEligibility{
		Sessions: 8, MinimumSessions: 8, MaximumPatience: 18,
		TargetCompletion: .85, MinimumCompletion: .80,
		LiquidityOK: false, PublicSentimentOK: true, StochasticProbability: 1,
	}, rand.New(rand.NewSource(1)))
	if ok {
		t.Fatal("Bandar transitioned without public liquidity condition")
	}
}

func TestPredictabilitySmokeThirtyDeterministicRuns(t *testing.T) {
	ratios := map[string]float64{"noise": .5, "momentum": .3, "market_maker": .2}
	var registry []Bot
	for strategy := range ratios {
		for index := 0; index < 100; index++ {
			registry = append(registry, Bot{ID: strategy + "-" + string(rune(index+1000)), Strategy: strategy})
		}
	}
	populations := map[string]struct{}{}
	drifts := map[float64]struct{}{}
	var transitions int
	for seed := int64(1); seed <= 30; seed++ {
		selected, err := Rotate(registry, 100, ratios, seed)
		if err != nil {
			t.Fatal(err)
		}
		ids := make([]string, len(selected))
		for index := range selected {
			ids[index] = selected[index].ID
		}
		populations[strings.Join(ids, ",")] = struct{}{}
		drift, err := Drift(100, 90, 110, .1, .3, 100, rand.New(rand.NewSource(seed)))
		if err != nil {
			t.Fatal(err)
		}
		drifts[drift] = struct{}{}
		ok, _ := CanTransitionBandar(BandarEligibility{
			Sessions: 12, MinimumSessions: 8, MaximumPatience: 18,
			TargetCompletion: .9, MinimumCompletion: .8, LiquidityOK: true,
			PublicSentimentOK: true, StochasticProbability: .5,
		}, rand.New(rand.NewSource(seed)))
		if ok {
			transitions++
		}
	}
	if len(populations) < 20 || len(drifts) < 20 || transitions == 0 || transitions == 30 {
		t.Fatalf("predictability smoke failed: populations=%d drifts=%d transitions=%d",
			len(populations), len(drifts), transitions)
	}
}
