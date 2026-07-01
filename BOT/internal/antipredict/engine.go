// Package antipredict implements the mandatory anti-predictability baseline.
// Inputs intentionally contain public market aggregates only; player identity,
// portfolio, and private order state are not representable by this API.
package antipredict

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"math"
	"math/rand"
	"sort"
	"time"

	"github.com/google/uuid"
)

type Seeder struct {
	secret       []byte
	modelVersion string
}

func NewSeeder(secret []byte, modelVersion string) (*Seeder, error) {
	if len(secret) < 32 {
		return nil, errors.New("session seed secret must be at least 32 bytes")
	}
	if modelVersion == "" {
		return nil, errors.New("model version is required")
	}
	return &Seeder{secret: append([]byte(nil), secret...), modelVersion: modelVersion}, nil
}

func (s *Seeder) SessionSeed(botID string, sessionID uuid.UUID, configVersion int64) (int64, error) {
	if botID == "" || sessionID == uuid.Nil || configVersion < 1 {
		return 0, errors.New("bot, session, and positive config version are required")
	}
	mac := hmac.New(sha256.New, s.secret)
	_, _ = mac.Write([]byte(s.modelVersion))
	_, _ = mac.Write([]byte{0})
	_, _ = mac.Write([]byte(botID))
	_, _ = mac.Write(sessionID[:])
	var version [8]byte
	binary.BigEndian.PutUint64(version[:], uint64(configVersion))
	_, _ = mac.Write(version[:])
	return int64(binary.BigEndian.Uint64(mac.Sum(nil)[:8]) & math.MaxInt64), nil
}

type Bot struct {
	ID       string
	Strategy string
	Pinned   bool
	HasState bool
}

// Rotate selects an exact-size population deterministically. Pinned bots and
// bots requiring lifecycle cleanup remain selected; remaining capacity follows
// target ratios using largest-remainder allocation.
func Rotate(registry []Bot, target int, ratios map[string]float64, seed int64) ([]Bot, error) {
	if target < 1 || target > len(registry) {
		return nil, errors.New("target must fit registry")
	}
	totalRatio := 0.0
	for _, ratio := range ratios {
		if ratio < 0 || ratio > 1 {
			return nil, errors.New("ratio outside [0,1]")
		}
		totalRatio += ratio
	}
	if math.Abs(totalRatio-1) > 1e-9 {
		return nil, errors.New("strategy ratios must sum to one")
	}
	selected := make(map[string]Bot)
	counts := make(map[string]int)
	for _, bot := range registry {
		if bot.ID == "" || bot.Strategy == "" {
			return nil, errors.New("bot ID and strategy are required")
		}
		if bot.Pinned || bot.HasState {
			selected[bot.ID], counts[bot.Strategy] = bot, counts[bot.Strategy]+1
		}
	}
	if len(selected) > target {
		return nil, errors.New("pinned/stateful population exceeds target")
	}
	type remainder struct {
		strategy string
		value    float64
	}
	quotas := make(map[string]int)
	var remainders []remainder
	assigned := 0
	for strategy, ratio := range ratios {
		exact := float64(target) * ratio
		quotas[strategy] = int(math.Floor(exact))
		assigned += quotas[strategy]
		remainders = append(remainders, remainder{strategy, exact - math.Floor(exact)})
	}
	sort.Slice(remainders, func(i, j int) bool {
		if remainders[i].value == remainders[j].value {
			return remainders[i].strategy < remainders[j].strategy
		}
		return remainders[i].value > remainders[j].value
	})
	for index := 0; assigned < target; index, assigned = index+1, assigned+1 {
		quotas[remainders[index].strategy]++
	}
	rng := rand.New(rand.NewSource(seed))
	candidates := append([]Bot(nil), registry...)
	rng.Shuffle(len(candidates), func(i, j int) { candidates[i], candidates[j] = candidates[j], candidates[i] })
	for _, bot := range candidates {
		if len(selected) == target {
			break
		}
		if _, exists := selected[bot.ID]; exists || counts[bot.Strategy] >= quotas[bot.Strategy] {
			continue
		}
		selected[bot.ID] = bot
		counts[bot.Strategy]++
	}
	if len(selected) != target {
		return nil, errors.New("registry cannot satisfy target strategy ratios")
	}
	result := make([]Bot, 0, target)
	for _, bot := range selected {
		result = append(result, bot)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	return result, nil
}

func Drift(base, minimum, maximum, maxRelativeChange, meanReversion, previous float64, rng *rand.Rand) (float64, error) {
	if rng == nil || minimum > base || base > maximum || maxRelativeChange < 0 ||
		maxRelativeChange > 1 || meanReversion < 0 || meanReversion > 1 {
		return 0, errors.New("invalid drift bounds")
	}
	center := previous + (base-previous)*meanReversion
	change := base * maxRelativeChange
	return clamp(center+(rng.Float64()*2-1)*change, minimum, maximum), nil
}

type PublicSignals struct {
	TradeCount       int
	Persistence      time.Duration
	VolumeConfirmed  bool
	PriceChangeRatio float64
}

type SignalGate struct {
	MinimumTrades      int
	MinimumPersistence time.Duration
	RequireVolume      bool
	EntryThreshold     float64
	ExitThreshold      float64
	CooldownMin        time.Duration
	CooldownMax        time.Duration
	active             map[string]bool
	cooldownUntil      map[string]time.Time
}

func NewSignalGate() *SignalGate {
	return &SignalGate{active: map[string]bool{}, cooldownUntil: map[string]time.Time{}}
}

func (g *SignalGate) Evaluate(botID string, now time.Time, signals PublicSignals, rng *rand.Rand) (bool, error) {
	if botID == "" || rng == nil || g.MinimumTrades < 1 || g.MinimumPersistence < 0 ||
		g.ExitThreshold >= g.EntryThreshold || g.CooldownMin < 0 || g.CooldownMax < g.CooldownMin {
		return false, errors.New("invalid signal gate")
	}
	if now.Before(g.cooldownUntil[botID]) {
		return false, nil
	}
	if g.active[botID] {
		if signals.PriceChangeRatio <= g.ExitThreshold {
			g.active[botID] = false
			span := g.CooldownMax - g.CooldownMin
			cooldown := g.CooldownMin
			if span > 0 {
				cooldown += time.Duration(rng.Int63n(int64(span) + 1))
			}
			g.cooldownUntil[botID] = now.Add(cooldown)
		}
		return g.active[botID], nil
	}
	confirmed := signals.TradeCount >= g.MinimumTrades &&
		signals.Persistence >= g.MinimumPersistence &&
		(!g.RequireVolume || signals.VolumeConfirmed)
	if confirmed && signals.PriceChangeRatio >= g.EntryThreshold {
		g.active[botID] = true
	}
	return g.active[botID], nil
}

type BandarEligibility struct {
	Sessions              int
	MinimumSessions       int
	MaximumPatience       int
	TargetCompletion      float64
	MinimumCompletion     float64
	LiquidityOK           bool
	PublicSentimentOK     bool
	StochasticProbability float64
}

func CanTransitionBandar(input BandarEligibility, rng *rand.Rand) (bool, error) {
	if rng == nil || input.MinimumSessions < 1 || input.MaximumPatience < input.MinimumSessions ||
		input.MinimumCompletion < 0 || input.MinimumCompletion > 1 ||
		input.StochasticProbability < 0 || input.StochasticProbability > 1 {
		return false, errors.New("invalid Bandar eligibility")
	}
	if input.Sessions < input.MinimumSessions || input.Sessions > input.MaximumPatience ||
		input.TargetCompletion < input.MinimumCompletion || !input.LiquidityOK || !input.PublicSentimentOK {
		return false, nil
	}
	return rng.Float64() < input.StochasticProbability, nil
}

func clamp(value, minimum, maximum float64) float64 {
	return math.Max(minimum, math.Min(maximum, value))
}
