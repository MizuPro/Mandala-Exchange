// Package sentiment owns the versioned global/sector sentiment context and
// computes bounded herd contagion from public aggregate market signals.
package sentiment

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

type Overall string
type VolatilityRegime string
type Direction string
type SectorTone string

const (
	Bearish Overall = "bearish"
	Neutral Overall = "neutral"
	Bullish Overall = "bullish"

	VolatilityLow    VolatilityRegime = "low"
	VolatilityMedium VolatilityRegime = "medium"
	VolatilityHigh   VolatilityRegime = "high"

	DirectionNone Direction = "none"
	DirectionBuy  Direction = "buy"
	DirectionSell Direction = "sell"

	SectorNegative SectorTone = "negative"
	SectorNeutral  SectorTone = "neutral"
	SectorPositive SectorTone = "positive"
)

var (
	ErrVersionConflict = errors.New("sentiment version conflict")
	ErrNotInitialized  = errors.New("sentiment state not initialized")
)

type State struct {
	Version           int64
	SessionInstanceID uuid.UUID
	Overall           Overall
	VolatilityRegime  VolatilityRegime
	SectorSentiment   map[string]SectorTone
	IsOverride        bool
	ValidUntil        time.Time
	Source            string
	CreatedAt         time.Time
}

type Repository interface {
	LoadLatest(ctx context.Context) (base *State, override *State, err error)
	Append(ctx context.Context, state State, expectedVersion int64) error
}

type Service struct {
	mu       sync.RWMutex
	repo     Repository
	base     *State
	override *State
}

func NewService(repo Repository) *Service {
	return &Service{repo: repo}
}

func (s *Service) Load(ctx context.Context) error {
	base, override, err := s.repo.LoadLatest(ctx)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.base = cloneState(base)
	s.override = cloneState(override)
	return nil
}

// EnsureSession versions the base state exactly once for a new authoritative
// session. Existing sentiment is carried forward; an override never becomes
// the next session's base.
func (s *Service) EnsureSession(ctx context.Context, sessionID uuid.UUID) (State, error) {
	if sessionID == uuid.Nil {
		return State{}, errors.New("session instance ID is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.base != nil && s.base.SessionInstanceID == sessionID {
		return *cloneState(s.base), nil
	}
	next := State{
		SessionInstanceID: sessionID,
		Overall:           Neutral, VolatilityRegime: VolatilityMedium,
		SectorSentiment: map[string]SectorTone{},
		Source:          "session_rollover", CreatedAt: time.Now().UTC(),
	}
	expected := latestVersion(s.base, s.override)
	if s.base != nil {
		next.Overall = s.base.Overall
		next.VolatilityRegime = s.base.VolatilityRegime
		next.SectorSentiment = cloneSectors(s.base.SectorSentiment)
	}
	next.SectorSentiment = cloneSectors(next.SectorSentiment)
	next.Version = expected + 1
	if err := validateState(next); err != nil {
		return State{}, err
	}
	if err := s.repo.Append(ctx, next, expected); err != nil {
		return State{}, err
	}
	s.base = cloneState(&next)
	return next, nil
}

func (s *Service) SetBase(ctx context.Context, next State, expectedVersion int64) (State, error) {
	next.IsOverride = false
	next.ValidUntil = time.Time{}
	return s.set(ctx, next, expectedVersion)
}

func (s *Service) SetOverride(ctx context.Context, next State, expectedVersion int64) (State, error) {
	next.IsOverride = true
	if next.ValidUntil.IsZero() || !next.ValidUntil.After(time.Now()) {
		return State{}, errors.New("override valid_until must be in the future")
	}
	return s.set(ctx, next, expectedVersion)
}

func (s *Service) set(ctx context.Context, next State, expectedVersion int64) (State, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	currentVersion := latestVersion(s.base, s.override)
	if currentVersion != expectedVersion {
		return State{}, ErrVersionConflict
	}
	next.Version = currentVersion + 1
	next.CreatedAt = time.Now().UTC()
	next.SectorSentiment = cloneSectors(next.SectorSentiment)
	if err := validateState(next); err != nil {
		return State{}, err
	}
	if err := s.repo.Append(ctx, next, expectedVersion); err != nil {
		return State{}, err
	}
	if next.IsOverride {
		s.override = cloneState(&next)
	} else {
		s.base = cloneState(&next)
	}
	return *cloneState(&next), nil
}

// Current returns the override only while it is valid. Expired overrides
// automatically fall back to the last base state without mutating history.
func (s *Service) Current(now time.Time) (State, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.override != nil && now.Before(s.override.ValidUntil) {
		return *cloneState(s.override), nil
	}
	if s.base == nil {
		return State{}, ErrNotInitialized
	}
	return *cloneState(s.base), nil
}

type ContagionConfig struct {
	MinimumTradeCount        int
	BuyConcentrationTrigger  float64
	SellConcentrationTrigger float64
	BaseProbability          float64
	ProbabilityCap           float64
	SentimentMultiplier      float64
	HighVolatilityMultiplier float64
}

func DefaultContagionConfig() ContagionConfig {
	return ContagionConfig{
		MinimumTradeCount:        3,
		BuyConcentrationTrigger:  .70,
		SellConcentrationTrigger: .30,
		BaseProbability:          .20,
		ProbabilityCap:           .60,
		SentimentMultiplier:      1.25,
		HighVolatilityMultiplier: 1.25,
	}
}

type PublicSignal struct {
	Symbol         string
	Sector         string
	TradeCount     int
	BuyTradeRatio  float64
	PriceChangePct float64
	ARBPercent     float64
}

type ContagionResult struct {
	Direction        Direction
	Probability      float64
	SentimentVersion int64
	Reason           string
}

// EvaluateContagion uses trade concentration and price movement that are
// observable by every player. It never consumes bot identity or private order
// state and never creates a signal without a qualifying public trigger.
func EvaluateContagion(state State, cfg ContagionConfig, signal PublicSignal, susceptibility float64) (ContagionResult, error) {
	if err := validateContagion(cfg, signal, susceptibility); err != nil {
		return ContagionResult{}, err
	}
	if state.Version <= 0 ||
		(state.Overall != Bearish && state.Overall != Neutral && state.Overall != Bullish) ||
		(state.VolatilityRegime != VolatilityLow && state.VolatilityRegime != VolatilityMedium && state.VolatilityRegime != VolatilityHigh) {
		return ContagionResult{}, errors.New("invalid effective sentiment state")
	}
	result := ContagionResult{Direction: DirectionNone, SentimentVersion: state.Version}
	if signal.TradeCount < cfg.MinimumTradeCount {
		result.Reason = "insufficient_public_trades"
		return result, nil
	}
	switch {
	case signal.ARBPercent > 0 && signal.PriceChangePct <= -(signal.ARBPercent/2):
		result.Direction, result.Reason = DirectionSell, "public_price_drop"
	case signal.BuyTradeRatio >= cfg.BuyConcentrationTrigger:
		result.Direction, result.Reason = DirectionBuy, "public_buy_concentration"
	case signal.BuyTradeRatio <= cfg.SellConcentrationTrigger:
		result.Direction, result.Reason = DirectionSell, "public_sell_concentration"
	default:
		result.Reason = "no_public_contagion_trigger"
		return result, nil
	}
	probability := cfg.BaseProbability * susceptibility
	bullish, bearish := state.Overall == Bullish, state.Overall == Bearish
	if sector, ok := state.SectorSentiment[normalizeSector(signal.Sector)]; ok {
		bullish, bearish = sector == SectorPositive, sector == SectorNegative
	}
	if (result.Direction == DirectionBuy && bullish) ||
		(result.Direction == DirectionSell && bearish) {
		probability *= cfg.SentimentMultiplier
	}
	if state.VolatilityRegime == VolatilityHigh {
		probability *= cfg.HighVolatilityMultiplier
	}
	if probability > cfg.ProbabilityCap {
		probability = cfg.ProbabilityCap
	}
	result.Probability = probability
	return result, nil
}

func validateState(state State) error {
	if state.Version <= 0 {
		return errors.New("version must be positive")
	}
	if state.SessionInstanceID == uuid.Nil {
		return errors.New("session instance ID is required")
	}
	if state.Overall != Bearish && state.Overall != Neutral && state.Overall != Bullish {
		return fmt.Errorf("invalid overall sentiment %q", state.Overall)
	}
	if state.VolatilityRegime != VolatilityLow && state.VolatilityRegime != VolatilityMedium && state.VolatilityRegime != VolatilityHigh {
		return fmt.Errorf("invalid volatility regime %q", state.VolatilityRegime)
	}
	if strings.TrimSpace(state.Source) == "" {
		return errors.New("source is required")
	}
	for sector, value := range state.SectorSentiment {
		if normalizeSector(sector) == "" || (value != SectorNegative && value != SectorNeutral && value != SectorPositive) {
			return fmt.Errorf("invalid sector sentiment %q=%q", sector, value)
		}
	}
	if state.IsOverride != !state.ValidUntil.IsZero() {
		return errors.New("override and valid_until must be set together")
	}
	return nil
}

func validateContagion(cfg ContagionConfig, signal PublicSignal, susceptibility float64) error {
	if cfg.MinimumTradeCount <= 0 || cfg.BaseProbability < 0 || cfg.BaseProbability > 1 ||
		cfg.ProbabilityCap < 0 || cfg.ProbabilityCap > 1 ||
		cfg.BuyConcentrationTrigger <= cfg.SellConcentrationTrigger ||
		cfg.BuyConcentrationTrigger > 1 || cfg.SellConcentrationTrigger < 0 ||
		cfg.SentimentMultiplier < 0 || cfg.HighVolatilityMultiplier < 0 {
		return errors.New("invalid contagion config")
	}
	if signal.TradeCount < 0 || signal.BuyTradeRatio < 0 || signal.BuyTradeRatio > 1 ||
		signal.ARBPercent < 0 || signal.ARBPercent > 1 ||
		susceptibility < 0 || susceptibility > 1 {
		return errors.New("invalid public signal or susceptibility")
	}
	return nil
}

func latestVersion(states ...*State) int64 {
	var version int64
	for _, state := range states {
		if state != nil && state.Version > version {
			version = state.Version
		}
	}
	return version
}

func cloneState(state *State) *State {
	if state == nil {
		return nil
	}
	copy := *state
	copy.SectorSentiment = cloneSectors(state.SectorSentiment)
	return &copy
}

func cloneSectors(source map[string]SectorTone) map[string]SectorTone {
	result := make(map[string]SectorTone, len(source))
	for key, value := range source {
		result[normalizeSector(key)] = value
	}
	return result
}

func normalizeSector(value string) string {
	return strings.ToUpper(strings.TrimSpace(value))
}
