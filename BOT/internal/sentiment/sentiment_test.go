package sentiment

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

type memoryRepository struct {
	mu     sync.Mutex
	states []State
}

func (r *memoryRepository) LoadLatest(context.Context) (*State, *State, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var base, override *State
	for i := range r.states {
		state := r.states[i]
		if state.IsOverride {
			if override == nil || state.Version > override.Version {
				override = cloneState(&state)
			}
		} else if base == nil || state.Version > base.Version {
			base = cloneState(&state)
		}
	}
	return base, override, nil
}

func (r *memoryRepository) Append(_ context.Context, state State, expected int64) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	var latest int64
	for _, existing := range r.states {
		if existing.Version > latest {
			latest = existing.Version
		}
	}
	if latest != expected || state.Version != expected+1 {
		return ErrVersionConflict
	}
	r.states = append(r.states, *cloneState(&state))
	return nil
}

func TestSessionVersioningAndDefensiveCopies(t *testing.T) {
	service := NewService(&memoryRepository{})
	firstID, secondID := uuid.New(), uuid.New()
	first, err := service.EnsureSession(context.Background(), firstID)
	if err != nil {
		t.Fatal(err)
	}
	same, err := service.EnsureSession(context.Background(), firstID)
	if err != nil || same.Version != first.Version {
		t.Fatalf("same session was versioned again: %+v, %v", same, err)
	}
	first.SectorSentiment["FINANCE"] = SectorPositive
	second, err := service.EnsureSession(context.Background(), secondID)
	if err != nil {
		t.Fatal(err)
	}
	if second.Version != 2 || len(second.SectorSentiment) != 0 {
		t.Fatalf("unexpected second state: %+v", second)
	}
}

func TestOverrideExpiryFallsBackToBase(t *testing.T) {
	service := NewService(&memoryRepository{})
	sessionID := uuid.New()
	base, err := service.EnsureSession(context.Background(), sessionID)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	override, err := service.SetOverride(context.Background(), State{
		SessionInstanceID: sessionID,
		Overall:           Bearish, VolatilityRegime: VolatilityHigh,
		SectorSentiment: map[string]SectorTone{"finance": SectorNegative},
		ValidUntil:      now.Add(time.Minute), Source: "admin",
	}, base.Version)
	if err != nil {
		t.Fatal(err)
	}
	active, err := service.Current(now)
	if err != nil || active.Version != override.Version || active.Overall != Bearish {
		t.Fatalf("override not active: %+v, %v", active, err)
	}
	fallback, err := service.Current(now.Add(2 * time.Minute))
	if err != nil || fallback.Version != base.Version || fallback.Overall != Neutral {
		t.Fatalf("expired override did not fall back: %+v, %v", fallback, err)
	}
	active.SectorSentiment["FINANCE"] = SectorPositive
	again, _ := service.Current(now)
	if again.SectorSentiment["FINANCE"] != SectorNegative {
		t.Fatal("caller mutated service state")
	}
}

func TestOptimisticVersionConflict(t *testing.T) {
	service := NewService(&memoryRepository{})
	base, err := service.EnsureSession(context.Background(), uuid.New())
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.SetBase(context.Background(), State{
		Overall: Bullish, VolatilityRegime: VolatilityLow,
		SectorSentiment: map[string]SectorTone{}, Source: "model",
	}, base.Version-1)
	if !errors.Is(err, ErrVersionConflict) {
		t.Fatalf("expected version conflict, got %v", err)
	}
}

func TestConcurrentUpdateAllowsSingleWinner(t *testing.T) {
	service := NewService(&memoryRepository{})
	base, err := service.EnsureSession(context.Background(), uuid.New())
	if err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	results := make(chan error, 2)
	for i := 0; i < 2; i++ {
		go func() {
			<-start
			_, updateErr := service.SetBase(context.Background(), State{
				SessionInstanceID: base.SessionInstanceID,
				Overall:           Bullish, VolatilityRegime: VolatilityMedium,
				SectorSentiment: map[string]SectorTone{}, Source: "model",
			}, base.Version)
			results <- updateErr
		}()
	}
	close(start)
	var successes, conflicts int
	for i := 0; i < 2; i++ {
		err := <-results
		if err == nil {
			successes++
		} else if errors.Is(err, ErrVersionConflict) {
			conflicts++
		} else {
			t.Fatalf("unexpected update error: %v", err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("successes/conflicts = %d/%d", successes, conflicts)
	}
}

func TestLoadRestoresBaseAndOverride(t *testing.T) {
	repo := &memoryRepository{}
	first := NewService(repo)
	base, _ := first.EnsureSession(context.Background(), uuid.New())
	_, err := first.SetOverride(context.Background(), State{
		SessionInstanceID: base.SessionInstanceID,
		Overall:           Bullish, VolatilityRegime: VolatilityHigh,
		SectorSentiment: map[string]SectorTone{}, Source: "admin",
		ValidUntil: time.Now().Add(time.Hour),
	}, base.Version)
	if err != nil {
		t.Fatal(err)
	}
	restarted := NewService(repo)
	if err := restarted.Load(context.Background()); err != nil {
		t.Fatal(err)
	}
	current, err := restarted.Current(time.Now())
	if err != nil || !current.IsOverride || current.Overall != Bullish {
		t.Fatalf("restart did not restore override: %+v, %v", current, err)
	}
}

func TestContagionUsesPublicSignalsAndCapsProbability(t *testing.T) {
	state := State{
		Version: 7, Overall: Neutral, VolatilityRegime: VolatilityHigh,
		SectorSentiment: map[string]SectorTone{"FINANCE": SectorPositive},
	}
	cfg := DefaultContagionConfig()
	cfg.BaseProbability = .9
	cfg.ProbabilityCap = .55
	result, err := EvaluateContagion(state, cfg, PublicSignal{
		Symbol: "BBCA", Sector: "finance", TradeCount: 10,
		BuyTradeRatio: .8, PriceChangePct: .01, ARBPercent: .15,
	}, 1)
	if err != nil {
		t.Fatal(err)
	}
	if result.Direction != DirectionBuy || result.Probability != .55 ||
		result.SentimentVersion != 7 || result.Reason != "public_buy_concentration" {
		t.Fatalf("unexpected contagion: %+v", result)
	}
}

func TestContagionRequiresConfirmationAndSupportsPriceShock(t *testing.T) {
	state := State{Version: 1, Overall: Bearish, VolatilityRegime: VolatilityMedium, SectorSentiment: map[string]SectorTone{}}
	cfg := DefaultContagionConfig()
	insufficient, err := EvaluateContagion(state, cfg, PublicSignal{
		TradeCount: 2, BuyTradeRatio: 1, ARBPercent: .15,
	}, 1)
	if err != nil || insufficient.Direction != DirectionNone || insufficient.Probability != 0 {
		t.Fatalf("insufficient signal spread contagion: %+v, %v", insufficient, err)
	}
	shock, err := EvaluateContagion(state, cfg, PublicSignal{
		TradeCount: 5, BuyTradeRatio: .5, PriceChangePct: -.08, ARBPercent: .15,
	}, .5)
	if err != nil || shock.Direction != DirectionSell || shock.Probability <= 0 || shock.Probability > cfg.ProbabilityCap {
		t.Fatalf("price shock not handled: %+v, %v", shock, err)
	}
}

func TestValidationRejectsInvalidStateAndSignal(t *testing.T) {
	service := NewService(&memoryRepository{})
	if _, err := service.SetOverride(context.Background(), State{}, 0); err == nil {
		t.Fatal("invalid override accepted")
	}
	_, err := EvaluateContagion(State{}, DefaultContagionConfig(), PublicSignal{
		TradeCount: 3, BuyTradeRatio: 2,
	}, 1)
	if err == nil {
		t.Fatal("invalid public signal accepted")
	}
}
