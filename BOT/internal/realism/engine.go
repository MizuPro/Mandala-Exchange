// Package realism implements session-aware activity and bounded human
// imperfections. It does not submit orders; strategy producers consume its
// decision plan before enqueueing through the normal Sekuritas path.
package realism

import (
	"errors"
	"fmt"
	"math"
	"math/rand"
	"sync"
	"time"

	"github.com/Mandala-Exchange/BOT/internal/config"
	"github.com/Mandala-Exchange/BOT/internal/marketrules"
	"github.com/Mandala-Exchange/BOT/internal/session"
	"github.com/google/uuid"
)

var (
	ErrSessionUnavailable = errors.New("authoritative session unavailable")
	ErrInactiveSegment    = errors.New("strategy inactive in current session segment")
)

type SessionClock interface {
	GetInstance() *session.SessionInstance
	VirtualToRealDelay(time.Duration) time.Duration
	SessionProgress() float64
}

type OrderIntent struct {
	BotID          string
	Symbol         string
	Side           string
	PriceIDR       int64
	QuantityShares int64
}

type Plan struct {
	Abort               bool
	InactiveSession     bool
	ActivityMultiplier  float64
	ReactionDelay       time.Duration
	FatFingerApplied    bool
	OverreactionApplied bool
	Order               marketrules.ResolvedOrder
}

type Engine struct {
	mu       sync.Mutex
	rng      *rand.Rand
	inactive map[string]bool
}

func New(seed int64) *Engine {
	return &Engine{
		rng:      rand.New(rand.NewSource(seed)),
		inactive: make(map[string]bool),
	}
}

// PlanDecision applies inactivity, abort, U-curve frequency, delay,
// overreaction and valid-tick fat finger behavior in that order.
func (e *Engine) PlanDecision(
	clock SessionClock,
	rules *marketrules.SnapshotResolver,
	human config.HumanConfig,
	activity config.ActivityConfig,
	intent OrderIntent,
) (Plan, error) {
	if clock == nil || rules == nil {
		return Plan{}, ErrSessionUnavailable
	}
	if intent.BotID == "" {
		return Plan{}, errors.New("bot ID is required")
	}
	if err := config.ValidateHumanConfig(human); err != nil {
		return Plan{}, fmt.Errorf("human config: %w", err)
	}
	if err := config.ValidateActivityConfig(activity); err != nil {
		return Plan{}, fmt.Errorf("activity config: %w", err)
	}
	instance := clock.GetInstance()
	if instance == nil || instance.InstanceID == uuid.Nil {
		return Plan{}, ErrSessionUnavailable
	}
	if instance.Status != session.StateContinuous {
		return Plan{}, ErrInactiveSegment
	}

	e.mu.Lock()
	defer e.mu.Unlock()

	sessionBotKey := instance.InstanceID.String() + ":" + intent.BotID
	inactive, known := e.inactive[sessionBotKey]
	if !known {
		inactive = e.rng.Float64() < human.InactiveSessionProbability
		e.inactive[sessionBotKey] = inactive
	}
	plan := Plan{InactiveSession: inactive}
	if inactive {
		plan.Abort = true
		return plan, nil
	}

	plan.ActivityMultiplier = e.activityMultiplier(activity, clock.SessionProgress())
	virtualSeconds := e.sample(human.ReactionDelayVirtualSeconds)
	// More activity means a proportionally shorter decision interval.
	virtualDelay := time.Duration((virtualSeconds / plan.ActivityMultiplier) * float64(time.Second))
	plan.ReactionDelay = clock.VirtualToRealDelay(virtualDelay)
	if plan.ReactionDelay < 0 {
		return Plan{}, ErrSessionUnavailable
	}
	if e.rng.Float64() < human.DecisionAbortProbability {
		plan.Abort = true
		return plan, nil
	}

	price := intent.PriceIDR
	if human.PriceFatFingerRangeTicks > 0 && e.rng.Float64() < human.PriceFatFingerProbability {
		offset := 1 + e.rng.Intn(human.PriceFatFingerRangeTicks)
		if e.rng.Intn(2) == 0 {
			offset = -offset
		}
		adjusted, err := rules.AdjustPriceTicks(intent.Symbol, intent.Side, price, offset)
		if err != nil {
			return Plan{}, err
		}
		price = adjusted
		plan.FatFingerApplied = true
	}

	quantity := intent.QuantityShares
	if e.rng.Float64() < human.OverreactionProbability {
		multiplier := e.sample(human.OverreactionMultiplier)
		if multiplier > 1 {
			if float64(quantity) > float64(math.MaxInt64)/multiplier {
				return Plan{}, errors.New("overreaction quantity overflow")
			}
			quantity = int64(math.Floor(float64(quantity) * multiplier))
			plan.OverreactionApplied = true
		}
	}
	resolved, err := rules.Resolve(intent.Symbol, intent.Side, price, quantity)
	if err != nil {
		return Plan{}, err
	}
	plan.Order = resolved
	return plan, nil
}

func (e *Engine) activityMultiplier(cfg config.ActivityConfig, progress float64) float64 {
	if progress < 0 {
		progress = 0
	} else if progress > 1 {
		progress = 1
	}
	switch {
	case progress < cfg.MorningRushEndProgress:
		return e.sample(cfg.MorningMultiplier)
	case progress >= cfg.ClosingRushStartProgress:
		return e.sample(cfg.ClosingMultiplier)
	default:
		return e.sample(cfg.MiddayMultiplier)
	}
}

func (e *Engine) sample(d config.Distribution) float64 {
	switch d.Type {
	case "fixed":
		return d.Min
	case "uniform":
		return d.Min + e.rng.Float64()*(d.Max-d.Min)
	case "normal":
		return clamp(e.rng.NormFloat64()*d.StdDev+d.Mean, d.Min, d.Max)
	case "lognormal":
		return clamp(math.Exp(e.rng.NormFloat64()*d.StdDev+d.Mean), d.Min, d.Max)
	default:
		panic("validated distribution became unsupported")
	}
}

func clamp(value, min, max float64) float64 {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}
