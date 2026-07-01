package strategystate

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
)

type Strategy string

const (
	StrategyBandar        Strategy = "bandar"
	StrategyValueInvestor Strategy = "value_investor"
	StrategyIndexTracker  Strategy = "index_tracker"
)

type Reason string

const (
	ReasonTransition     Reason = "transition"
	ReasonMaterialChange Reason = "material_change"
	ReasonShutdown       Reason = "shutdown"
)

var (
	ErrNotFound        = errors.New("strategy state bot not found")
	ErrVersionConflict = errors.New("strategy state version conflict")
)

// Checkpoint records the public-input boundary from which strategy evaluation
// can safely resume. Account state itself is always restored from Sekuritas.
type Checkpoint struct {
	SessionInstanceID uuid.UUID `json:"session_instance_id"`
	EventSequence     int64     `json:"event_sequence"`
	SchedulerSequence int64     `json:"scheduler_sequence"`
}

type Snapshot struct {
	BotID             string
	Strategy          Strategy
	StateVersion      int64
	SessionInstanceID uuid.UUID
	State             json.RawMessage
	Checkpoint        Checkpoint
	Reason            Reason
	CreatedAt         time.Time
}

func (s Snapshot) Validate() error {
	if s.BotID == "" {
		return errors.New("bot_id is required")
	}
	switch s.Strategy {
	case StrategyBandar, StrategyValueInvestor, StrategyIndexTracker:
	default:
		return fmt.Errorf("unsupported persistent strategy %q", s.Strategy)
	}
	switch s.Reason {
	case ReasonTransition, ReasonMaterialChange, ReasonShutdown:
	default:
		return fmt.Errorf("invalid snapshot reason %q", s.Reason)
	}
	if s.StateVersion < 0 {
		return errors.New("state_version cannot be negative")
	}
	if s.Checkpoint.EventSequence < 0 || s.Checkpoint.SchedulerSequence < 0 {
		return errors.New("checkpoint sequence cannot be negative")
	}
	if s.SessionInstanceID != uuid.Nil &&
		s.Checkpoint.SessionInstanceID != uuid.Nil &&
		s.SessionInstanceID != s.Checkpoint.SessionInstanceID {
		return errors.New("snapshot and checkpoint session_instance_id differ")
	}
	if len(s.State) == 0 || !json.Valid(s.State) {
		return errors.New("strategy state must be valid JSON")
	}
	trimmed := bytes.TrimSpace(s.State)
	if len(trimmed) < 2 || trimmed[0] != '{' {
		return errors.New("strategy state must be a JSON object")
	}
	return nil
}

func clone(snapshot Snapshot) Snapshot {
	snapshot.State = append(json.RawMessage(nil), snapshot.State...)
	return snapshot
}
