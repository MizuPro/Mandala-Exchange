package bei

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/Mandala-Exchange/BOT/internal/client"
	"github.com/google/uuid"
)

// ── Freshness Contract (BOT_API_CONTRACTS.md §12) ─────────────────────────────

// FreshnessThresholds defines the max age for each BEI data source.
// Defaults match BOT_API_CONTRACTS.md §12.
type FreshnessThresholds struct {
	// RulesMaxAge is the maximum allowed age for trading rules snapshot.
	RulesMaxAge time.Duration // default 300s
	// FeesMaxAge is the maximum allowed age for fee schedule snapshot.
	FeesMaxAge time.Duration // default 300s
	// SessionMaxAge is the maximum allowed age for session state snapshot.
	// Staleness here triggers global submission pause.
	SessionMaxAge time.Duration // default 10s
	// MDXMaxAge is the maximum allowed age for MDX index composition.
	// Staleness here only disables Index Tracker strategy.
	MDXMaxAge time.Duration // default 300s
}

// DefaultFreshnessThresholds returns the normative defaults from BOT_API_CONTRACTS.md §12.
func DefaultFreshnessThresholds() FreshnessThresholds {
	return FreshnessThresholds{
		RulesMaxAge:   300 * time.Second,
		FeesMaxAge:    300 * time.Second,
		SessionMaxAge: 10 * time.Second,
		MDXMaxAge:     300 * time.Second,
	}
}

// ── Session Instance (BOT_API_CONTRACTS.md §10) ─────────────────────────────

// SessionInstance represents an active trading session from BEI.
// BEI is the owner and persistence authority for session_instance_id.
type SessionInstance struct {
	InstanceID          uuid.UUID `json:"session_instance_id"`
	SessionTemplateID   uuid.UUID `json:"session_template_id"`
	VirtualDayIndex     int       `json:"virtual_day_index"`
	Status              string    `json:"status"` // e.g. "continuous", "closing_auction", "closed"
	SegmentSequence     int       `json:"segment_sequence"`
	VirtualDurationSecs int       `json:"virtual_duration_seconds"`
	RealDurationSecs    int       `json:"real_duration_seconds"`
	RealTimeRemainSecs  int       `json:"real_time_remaining_seconds"`
	StartedAt           time.Time `json:"started_at"`
	ExpectedEndAt       time.Time `json:"expected_end_at"`
	Version             int64     `json:"version"`
}

// ── Snapshot ────────────────────────────────────────────────────────────────

// Snapshot holds all BEI data fetched in the last polling cycle.
// Each field has an independent FetchedAt timestamp for per-endpoint staleness.
type Snapshot struct {
	Securities   json.RawMessage
	SecuritiesAt time.Time

	Rules   json.RawMessage
	RulesAt time.Time

	Fees   json.RawMessage
	FeesAt time.Time

	Session   json.RawMessage
	SessionAt time.Time

	// Parsed SessionInstance derived from Session raw JSON.
	SessionInstance *SessionInstance

	MDX   json.RawMessage
	MDXAt time.Time

	Announcements   json.RawMessage
	AnnouncementsAt time.Time
}

// ── Client ───────────────────────────────────────────────────────────────────

// Client fetches and caches BEI data with per-endpoint freshness tracking.
// Per BOT_API_CONTRACTS.md §12:
//   - Session stale → global submission pause (caller checks IsSessionStale)
//   - Rules/fees stale → fail-closed order creation (caller checks IsRulesStale/IsFeesStale)
//   - MDX stale → only disable Index Tracker (caller checks IsMDXStale)
type Client struct {
	apiClient *client.APIClient
	mu        sync.RWMutex
	snapshot  Snapshot
	freshness FreshnessThresholds
}

// NewClient creates a BEI client with default freshness thresholds.
func NewClient(baseURL, token string) *Client {
	return &Client{
		apiClient: client.NewAPIClient(baseURL, token),
		freshness: DefaultFreshnessThresholds(),
	}
}

// SetFreshnessThresholds overrides the default freshness thresholds.
// Call before FetchData to take effect.
func (c *Client) SetFreshnessThresholds(f FreshnessThresholds) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.freshness = f
}

// FetchData fetches all BEI endpoints and records per-endpoint timestamps.
// Each endpoint is fetched independently; a failure on one does not prevent
// the others from being cached (partial update is acceptable for non-critical endpoints).
// However, a failure on session/rules/fees is returned immediately as those are critical.
func (c *Client) FetchData(ctx context.Context) error {
	type endpoint struct {
		path     string
		critical bool
	}
	endpoints := []endpoint{
		{"/public/securities", false},
		{"/integration/mats/rules", true},
		{"/public/fee-schedule", true},
		{"/integration/mats/sessions/active", true},
		{"/indices/MDX/composition", false},
		{"/announcements", false},
	}

	var (
		securities    json.RawMessage
		rules         json.RawMessage
		fees          json.RawMessage
		session       json.RawMessage
		mdx           json.RawMessage
		announcements json.RawMessage
	)
	targets := []*json.RawMessage{&securities, &rules, &fees, &session, &mdx, &announcements}
	now := time.Now().UTC()

	for i, ep := range endpoints {
		if err := c.apiClient.DoRequest(ctx, "GET", ep.path, nil, "", targets[i]); err != nil {
			if ep.critical {
				return err
			}
			// Non-critical endpoint failure: log but continue; stale data remains.
			continue
		}
		if len(*targets[i]) == 0 || string(*targets[i]) == "null" {
			if ep.critical {
				return errors.New("BEI returned empty response for " + ep.path)
			}
		}
	}

	// Parse session instance
	var sessionInstance *SessionInstance
	if len(session) > 0 && string(session) != "null" {
		var si SessionInstance
		if err := json.Unmarshal(session, &si); err == nil && si.InstanceID != uuid.Nil {
			sessionInstance = &si
		}
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	if len(securities) > 0 {
		c.snapshot.Securities = append(json.RawMessage(nil), securities...)
		c.snapshot.SecuritiesAt = now
	}
	if len(rules) > 0 {
		c.snapshot.Rules = append(json.RawMessage(nil), rules...)
		c.snapshot.RulesAt = now
	}
	if len(fees) > 0 {
		c.snapshot.Fees = append(json.RawMessage(nil), fees...)
		c.snapshot.FeesAt = now
	}
	if len(session) > 0 {
		c.snapshot.Session = append(json.RawMessage(nil), session...)
		c.snapshot.SessionAt = now
		c.snapshot.SessionInstance = sessionInstance
	}
	if len(mdx) > 0 {
		c.snapshot.MDX = append(json.RawMessage(nil), mdx...)
		c.snapshot.MDXAt = now
	}
	if len(announcements) > 0 {
		c.snapshot.Announcements = append(json.RawMessage(nil), announcements...)
		c.snapshot.AnnouncementsAt = now
	}
	return nil
}

// Snapshot returns a point-in-time copy of all BEI data.
// Caller should check each Is*Stale() method before using the returned data.
func (c *Client) Snapshot() (Snapshot, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.snapshot.SessionAt.IsZero() {
		// Session data is required for readiness
		return Snapshot{}, false
	}
	s := c.snapshot
	// Deep copy raw slices
	s.Securities = append(json.RawMessage(nil), s.Securities...)
	s.Rules = append(json.RawMessage(nil), s.Rules...)
	s.Fees = append(json.RawMessage(nil), s.Fees...)
	s.Session = append(json.RawMessage(nil), s.Session...)
	s.MDX = append(json.RawMessage(nil), s.MDX...)
	s.Announcements = append(json.RawMessage(nil), s.Announcements...)
	// Copy session instance pointer
	if s.SessionInstance != nil {
		si := *s.SessionInstance
		s.SessionInstance = &si
	}
	return s, true
}

// GetSessionInstance returns the most recently parsed session instance, or nil.
func (c *Client) GetSessionInstance() *SessionInstance {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.snapshot.SessionInstance == nil {
		return nil
	}
	si := *c.snapshot.SessionInstance
	return &si
}

// ── Per-Endpoint Freshness Checks (BOT_API_CONTRACTS.md §12) ────────────────

// IsSessionStale returns true if the session snapshot is older than SessionMaxAge.
// Per contract: session stale → global submission pause.
func (c *Client) IsSessionStale() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.snapshot.SessionAt.IsZero() || time.Since(c.snapshot.SessionAt) > c.freshness.SessionMaxAge
}

// IsRulesStale returns true if the rules snapshot is older than RulesMaxAge.
// Per contract: rules stale → fail-closed for new orders.
func (c *Client) IsRulesStale() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.snapshot.RulesAt.IsZero() || time.Since(c.snapshot.RulesAt) > c.freshness.RulesMaxAge
}

// IsFeesStale returns true if the fee schedule snapshot is older than FeesMaxAge.
// Per contract: fee stale → fail-closed for new orders.
func (c *Client) IsFeesStale() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.snapshot.FeesAt.IsZero() || time.Since(c.snapshot.FeesAt) > c.freshness.FeesMaxAge
}

// IsMDXStale returns true if the MDX composition is older than MDXMaxAge.
// Per contract: MDX stale → disable Index Tracker only (not global pause).
func (c *Client) IsMDXStale() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.snapshot.MDXAt.IsZero() || time.Since(c.snapshot.MDXAt) > c.freshness.MDXMaxAge
}

// IsStale returns true if ANY critical dependency (session, rules, or fees) is stale.
// Used by BreakerManager.MarkDependencyStale("bei") integration in main.go.
func (c *Client) IsStale() bool {
	return c.IsSessionStale() || c.IsRulesStale() || c.IsFeesStale()
}

// ListedSymbols returns the active symbols from the cached securities snapshot.
func (c *Client) ListedSymbols() ([]string, error) {
	c.mu.RLock()
	raw := append(json.RawMessage(nil), c.snapshot.Securities...)
	c.mu.RUnlock()

	if len(raw) == 0 {
		return nil, errors.New("BEI snapshot not loaded")
	}
	var securities []struct {
		Symbol string `json:"symbol"`
		Status string `json:"status"`
	}
	if err := json.Unmarshal(raw, &securities); err != nil {
		return nil, err
	}
	symbols := make([]string, 0, len(securities))
	for _, security := range securities {
		if security.Symbol != "" && security.Status == "listed" {
			symbols = append(symbols, security.Symbol)
		}
	}
	if len(symbols) == 0 {
		return nil, errors.New("BEI returned no listed securities")
	}
	return symbols, nil
}
