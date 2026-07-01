// Package eventcontext enforces the fairness boundary between public BEI
// announcements and simulation-only stress scenarios.
package eventcontext

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

type RuntimeMode string

const (
	ModeLive              RuntimeMode = "live"
	ModeDeterministicTest RuntimeMode = "deterministic_test"
	ModeStressTest        RuntimeMode = "stress_test"
)

var (
	ErrFutureInformation = errors.New("event publication is in the future")
	ErrUnpublishedEvent  = errors.New("normal event requires BEI announcement and published_at")
	ErrSimulationOnly    = errors.New("simulation-only event is forbidden in live mode")
	ErrDuplicateEvent    = errors.New("event already ingested")
)

type Announcement struct {
	ID          uuid.UUID
	IssuerID    uuid.UUID
	SecurityID  uuid.UUID
	Symbol      string
	Type        string
	Title       string
	PublishedAt time.Time
	ReceivedAt  time.Time
	Metadata    map[string]any
}

type ReactionContext struct {
	EventID         uuid.UUID
	Symbol          string
	EventType       string
	PublishedAt     time.Time
	ReceivedAt      time.Time
	ReactionStartAt time.Time
	Source          string
	SimulationOnly  bool
}

type Store struct {
	mu     sync.RWMutex
	events map[uuid.UUID]ReactionContext
}

func NewStore() *Store {
	return &Store{events: make(map[uuid.UUID]ReactionContext)}
}

// IngestBEI accepts only announcements already public at receipt time.
// Reaction delay starts at max(published_at, received_at), guaranteeing the BOT
// never reacts before the same public feed can be observed by players.
func (s *Store) IngestBEI(announcement Announcement, minimumPublicationAge time.Duration) (ReactionContext, error) {
	if announcement.ID == uuid.Nil || announcement.PublishedAt.IsZero() {
		return ReactionContext{}, ErrUnpublishedEvent
	}
	if announcement.ReceivedAt.IsZero() {
		return ReactionContext{}, errors.New("received_at is required")
	}
	if announcement.PublishedAt.After(announcement.ReceivedAt) {
		return ReactionContext{}, ErrFutureInformation
	}
	if minimumPublicationAge < 0 {
		return ReactionContext{}, errors.New("minimum publication age must not be negative")
	}
	simulationOnly, metadataErr := simulationOnlyMetadata(announcement.Metadata)
	if metadataErr != nil {
		return ReactionContext{}, metadataErr
	}
	if simulationOnly {
		return ReactionContext{}, errors.New("BEI public announcement cannot be simulation_only")
	}
	reactionStart := announcement.PublishedAt.Add(minimumPublicationAge)
	if reactionStart.Before(announcement.ReceivedAt) {
		reactionStart = announcement.ReceivedAt
	}
	context := ReactionContext{
		EventID: announcement.ID, Symbol: strings.ToUpper(announcement.Symbol),
		EventType: announcement.Type, PublishedAt: announcement.PublishedAt,
		ReceivedAt: announcement.ReceivedAt, ReactionStartAt: reactionStart,
		Source: "bei_public_announcement",
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.events[context.EventID]; exists {
		return ReactionContext{}, ErrDuplicateEvent
	}
	s.events[context.EventID] = context
	return context, nil
}

func (s *Store) Get(id uuid.UUID) (ReactionContext, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	context, ok := s.events[id]
	return context, ok
}

// IngestBEISnapshot parses the exact aggregate feed shared by BEI with
// Sekuritas/player. Duplicate polling is idempotent.
func (s *Store) IngestBEISnapshot(raw []byte, receivedAt time.Time, minimumPublicationAge time.Duration) (int, error) {
	var wire []struct {
		ID          uuid.UUID      `json:"id"`
		IssuerID    uuid.UUID      `json:"issuer_id"`
		SecurityID  uuid.UUID      `json:"security_id"`
		Symbol      string         `json:"symbol"`
		Type        string         `json:"type"`
		Title       string         `json:"title"`
		PublishedAt time.Time      `json:"published_at"`
		Metadata    map[string]any `json:"metadata"`
	}
	if err := json.Unmarshal(raw, &wire); err != nil {
		return 0, fmt.Errorf("decode BEI announcements: %w", err)
	}
	accepted := 0
	for _, item := range wire {
		_, err := s.IngestBEI(Announcement{
			ID: item.ID, IssuerID: item.IssuerID, SecurityID: item.SecurityID,
			Symbol: item.Symbol, Type: item.Type, Title: item.Title,
			PublishedAt: item.PublishedAt, ReceivedAt: receivedAt, Metadata: item.Metadata,
		}, minimumPublicationAge)
		if errors.Is(err, ErrDuplicateEvent) {
			continue
		}
		if err != nil {
			return accepted, err
		}
		accepted++
	}
	return accepted, nil
}

type ScenarioActor struct {
	ID             uuid.UUID
	Type           string
	SimulationOnly bool
	Symbols        []string
	Duration       time.Duration
	MaxTotalLots   int64
	CreatedAt      time.Time
}

// ValidateScenarioActor keeps Panic Seller outside autonomous population and
// makes it impossible to activate from normal live mode.
func ValidateScenarioActor(mode RuntimeMode, actor ScenarioActor) error {
	if actor.ID == uuid.Nil || actor.Type != "panic_seller" {
		return errors.New("only a typed panic_seller scenario actor is supported")
	}
	if mode != ModeStressTest && mode != ModeDeterministicTest {
		return ErrSimulationOnly
	}
	if !actor.SimulationOnly {
		return errors.New("panic seller must be marked simulation_only")
	}
	if actor.Duration <= 0 || actor.MaxTotalLots <= 0 {
		return errors.New("duration and max_total_lots must be positive")
	}
	if len(actor.Symbols) == 0 {
		return errors.New("scenario actor requires symbol scope")
	}
	for _, symbol := range actor.Symbols {
		if strings.TrimSpace(symbol) == "" {
			return errors.New("scenario actor contains empty symbol")
		}
	}
	return nil
}

func simulationOnlyMetadata(metadata map[string]any) (bool, error) {
	value, ok := metadata["simulation_only"]
	if !ok {
		return false, nil
	}
	flag, ok := value.(bool)
	if !ok {
		return false, errors.New("simulation_only metadata must be boolean")
	}
	return flag, nil
}
