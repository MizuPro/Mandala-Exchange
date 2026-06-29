package bei

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/Mandala-Exchange/BOT/internal/client"
)

type Snapshot struct {
	Securities json.RawMessage
	Rules      json.RawMessage
	Fees       json.RawMessage
	Session    json.RawMessage
	MDX        json.RawMessage
	FetchedAt  time.Time
}

type Freshness struct {
	Rules   time.Duration
	Fees    time.Duration
	Session time.Duration
	MDX     time.Duration
}

type Client struct {
	apiClient *client.APIClient
	mu        sync.RWMutex
	snapshot  Snapshot
	freshness Freshness
}

func NewClient(baseURL, token string) *Client {
	return &Client{
		apiClient: client.NewAPIClient(baseURL, token),
		freshness: Freshness{Rules: 300 * time.Second, Fees: 300 * time.Second, Session: 10 * time.Second, MDX: 300 * time.Second},
	}
}

func (c *Client) FetchData(ctx context.Context) error {
	var next Snapshot
	requests := []struct {
		path   string
		target *json.RawMessage
	}{
		{"/public/securities", &next.Securities},
		{"/integration/mats/rules", &next.Rules},
		{"/public/fee-schedule", &next.Fees},
		{"/integration/mats/sessions/active", &next.Session},
		{"/indices/MDX/composition", &next.MDX},
	}
	for _, request := range requests {
		if err := c.apiClient.DoRequest(ctx, "GET", request.path, nil, "", request.target); err != nil {
			return err
		}
		if len(*request.target) == 0 || string(*request.target) == "null" {
			return errors.New("BEI returned empty snapshot for " + request.path)
		}
	}
	next.FetchedAt = time.Now().UTC()
	c.mu.Lock()
	c.snapshot = next
	c.mu.Unlock()
	return nil
}

func (c *Client) Snapshot() (Snapshot, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.snapshot.FetchedAt.IsZero() {
		return Snapshot{}, false
	}
	result := c.snapshot
	result.Securities = append(json.RawMessage(nil), result.Securities...)
	result.Rules = append(json.RawMessage(nil), result.Rules...)
	result.Fees = append(json.RawMessage(nil), result.Fees...)
	result.Session = append(json.RawMessage(nil), result.Session...)
	result.MDX = append(json.RawMessage(nil), result.MDX...)
	return result, true
}

func (c *Client) ListedSymbols() ([]string, error) {
	snapshot, ok := c.Snapshot()
	if !ok {
		return nil, errors.New("BEI snapshot not loaded")
	}
	var securities []struct {
		Symbol string `json:"symbol"`
		Status string `json:"status"`
	}
	if err := json.Unmarshal(snapshot.Securities, &securities); err != nil {
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

func (c *Client) IsStale() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.snapshot.FetchedAt.IsZero() || time.Since(c.snapshot.FetchedAt) > c.freshness.Session
}
