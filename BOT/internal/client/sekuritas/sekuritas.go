package sekuritas

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/Mandala-Exchange/BOT/internal/client"
	"github.com/Mandala-Exchange/BOT/internal/logger"
	"github.com/Mandala-Exchange/BOT/internal/portfolio"
	"github.com/google/uuid"
	"nhooyr.io/websocket"
)

type Client struct {
	apiClient *client.APIClient

	tokenCache      map[string]string
	tokenExpiry     map[string]time.Time
	mu              sync.RWMutex
	streamConnected bool
}

func NewClient(baseURL, token string) *Client {
	return &Client{
		apiClient:   client.NewAPIClient(baseURL, token),
		tokenCache:  make(map[string]string),
		tokenExpiry: make(map[string]time.Time),
	}
}

type ProvisionBotRequest struct {
	ExternalBotID  string `json:"external_bot_id"`
	Email          string `json:"email"`
	DisplayName    string `json:"display_name"`
	Tier           string `json:"tier"`
	Strategy       string `json:"strategy"`
	InitialCashIDR int64  `json:"initial_cash_idr"`
}

type ProvisionBatchRequest struct {
	Bots []ProvisionBotRequest `json:"bots"`
}

type ProvisionResult struct {
	ExternalBotID string  `json:"external_bot_id"`
	Status        string  `json:"status"` // created, existing, failed
	UserID        string  `json:"user_id"`
	AccountID     string  `json:"account_id"`
	Error         *string `json:"error"`
}

type ProvisionBatchResponse struct {
	Results []ProvisionResult `json:"results"`
}

func (c *Client) ProvisionBots(ctx context.Context, req ProvisionBatchRequest, idempotencyKey string) (*ProvisionBatchResponse, error) {
	var resp ProvisionBatchResponse
	err := c.apiClient.DoRequest(ctx, "POST", "/internal/bots/provision", req, idempotencyKey, &resp)
	if err != nil {
		return nil, err
	}
	return &resp, nil
}

type TokenBatchRequest struct {
	AccountIDs []string `json:"account_ids"`
}

type TokenResult struct {
	AccountID string    `json:"account_id"`
	UserID    string    `json:"user_id"`
	Token     string    `json:"token"`
	IssuedAt  time.Time `json:"issued_at"`
	ExpiresAt time.Time `json:"expires_at"`
}

type TokenBatchResponse struct {
	Tokens []TokenResult `json:"tokens"`
}

func (c *Client) FetchTokens(ctx context.Context, accountIDs []string, idempotencyKey string) error {
	req := TokenBatchRequest{AccountIDs: accountIDs}
	var resp TokenBatchResponse
	err := c.apiClient.DoRequest(ctx, "POST", "/internal/bots/tokens", req, idempotencyKey, &resp)
	if err != nil {
		return err
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	for _, tk := range resp.Tokens {
		c.tokenCache[tk.AccountID] = tk.Token
		c.tokenExpiry[tk.AccountID] = tk.ExpiresAt
	}
	return nil
}

func (c *Client) GetToken(accountID string) (string, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	tk, ok := c.tokenCache[accountID]
	if !ok {
		return "", false
	}
	exp, ok := c.tokenExpiry[accountID]
	// Trigger staggered refresh if within 10 minutes of expiry (handled by a background worker)
	if ok && time.Now().Add(10*time.Minute).After(exp) {
		logger.Warn("Token close to expiry", map[string]interface{}{"account_id": accountID})
	}
	return tk, true
}

func (c *Client) TriggerGenesis(ctx context.Context, payload interface{}, idempotencyKey string) error {
	return c.apiClient.DoRequest(ctx, "POST", "/internal/bots/genesis", payload, idempotencyKey, nil)
}

type SnapshotRequest struct {
	AccountIDs        []string `json:"account_ids"`
	IncludeOpenOrders bool     `json:"include_open_orders"`
}

func (c *Client) BulkSnapshot(ctx context.Context, accountIDs []string) (portfolio.Snapshot, error) {
	var result portfolio.Snapshot
	if len(accountIDs) > 100 {
		return result, fmt.Errorf("snapshot batch exceeds 100 accounts")
	}
	key := "snapshot-" + uuid.NewString()
	err := c.apiClient.DoRequest(ctx, "POST", "/internal/bots/portfolio-snapshot", SnapshotRequest{AccountIDs: accountIDs, IncludeOpenOrders: true}, key, &result)
	return result, err
}

type StreamHandler func(portfolio.Event) error

func (c *Client) ConnectEventStream(ctx context.Context, afterSequence int64, handler StreamHandler) error {
	base, err := url.Parse(c.apiClient.BaseURL)
	if err != nil {
		return err
	}
	if base.Scheme == "https" {
		base.Scheme = "wss"
	} else {
		base.Scheme = "ws"
	}
	base.Path = strings.TrimRight(base.Path, "/") + "/internal/bots/events/ws"
	query := base.Query()
	query.Set("after_sequence", fmt.Sprint(afterSequence))
	base.RawQuery = query.Encode()
	headers := http.Header{}
	headers.Set("x-service-token", c.apiClient.Token)
	headers.Set("x-correlation-id", uuid.NewString())
	conn, resp, err := websocket.Dial(ctx, base.String(), &websocket.DialOptions{HTTPHeader: headers})
	if err != nil {
		if resp != nil {
			return fmt.Errorf("account stream dial status %d: %w", resp.StatusCode, err)
		}
		return err
	}
	defer conn.Close(websocket.StatusNormalClosure, "consumer stopped")
	c.mu.Lock()
	c.streamConnected = true
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		c.streamConnected = false
		c.mu.Unlock()
	}()
	conn.SetReadLimit(1 << 20)
	logger.Info("Connected to Sekuritas account stream", map[string]interface{}{"after_sequence": afterSequence})
	for {
		_, payload, err := conn.Read(ctx)
		if err != nil {
			return err
		}
		var event portfolio.Event
		if err := json.Unmarshal(payload, &event); err != nil {
			return fmt.Errorf("decode account event: %w", err)
		}
		if event.EventType == "heartbeat" {
			continue
		}
		if err := handler(event); err != nil {
			return err
		}
	}
}

func (c *Client) StreamConnected() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.streamConnected
}
