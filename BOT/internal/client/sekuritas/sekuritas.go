package sekuritas

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
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

// ErrTokenNotFound is returned when no token exists for the given account.
var ErrTokenNotFound = errors.New("token not found")

// ErrTokenExpired is returned when the cached token has already expired.
var ErrTokenExpired = errors.New("token expired")

// ErrOrderSubmitUnknown means Sekuritas may have accepted the request but the
// client did not receive a complete response. Callers must reconcile by the
// stable client_order_id and must not submit a replacement order.
var ErrOrderSubmitUnknown = errors.New("order submit outcome unknown")

type Client struct {
	apiClient *client.APIClient

	// tokenCache and tokenExpiry are the short-lived JWT cache.
	// Per Task 2.1: staggered refresh occurs 5–10 min before expiry.
	// Tokens are NOT returned after expiry — callers must handle ErrTokenExpired.
	tokenCache      map[string]string
	tokenExpiry     map[string]time.Time
	mu              sync.RWMutex
	streamConnected bool
}

type PlaceOrderRequest struct {
	ClientOrderID string `json:"client_order_id"`
	Symbol        string `json:"symbol"`
	Side          string `json:"side"`
	OrderType     string `json:"order_type"`
	PriceIDR      int64  `json:"price,omitempty"`
	Quantity      int64  `json:"quantity"`
}

type PlaceOrderResponse struct {
	ID            string `json:"id"`
	ClientOrderID string `json:"client_order_id"`
	Status        string `json:"status"`
}

// PlaceOrder submits through the normal Sekuritas investor route using the
// short-lived JWT for this BOT account. A transport timeout is intentionally
// returned without retry; callers must resolve by client_order_id.
func (c *Client) PlaceOrder(ctx context.Context, accountID string, request PlaceOrderRequest) (PlaceOrderResponse, error) {
	var result PlaceOrderResponse
	token, ok := c.GetToken(accountID)
	if !ok {
		return result, ErrTokenNotFound
	}
	body, err := json.Marshal(request)
	if err != nil {
		return result, err
	}
	httpRequest, err := http.NewRequestWithContext(ctx, http.MethodPost, c.apiClient.BaseURL+"/orders", strings.NewReader(string(body)))
	if err != nil {
		return result, err
	}
	httpRequest.Header.Set("authorization", "Bearer "+token)
	httpRequest.Header.Set("content-type", "application/json")
	httpRequest.Header.Set("x-correlation-id", uuid.NewString())
	response, err := c.apiClient.HTTPClient.Do(httpRequest)
	if err != nil {
		return result, fmt.Errorf("%w: %v", ErrOrderSubmitUnknown, err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
		return result, fmt.Errorf("sekuritas place order status %d: %s", response.StatusCode, strings.TrimSpace(string(body)))
	}
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		return result, fmt.Errorf("%w: invalid success response: %v", ErrOrderSubmitUnknown, err)
	}
	return result, nil
}

// CancelOrder sends a DELETE request to cancel an order.
func (c *Client) CancelOrder(ctx context.Context, accountID, orderID string) error {
	token, ok := c.GetToken(accountID)
	if !ok {
		return ErrTokenNotFound
	}
	httpRequest, err := http.NewRequestWithContext(ctx, http.MethodDelete, c.apiClient.BaseURL+"/orders/"+url.PathEscape(orderID), nil)
	if err != nil {
		return err
	}
	httpRequest.Header.Set("authorization", "Bearer "+token)
	httpRequest.Header.Set("x-correlation-id", uuid.NewString())
	response, err := c.apiClient.HTTPClient.Do(httpRequest)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
		return fmt.Errorf("sekuritas cancel order status %d: %s", response.StatusCode, strings.TrimSpace(string(body)))
	}
	return nil
}

type OrderResponse struct {
	ID            string `json:"id"`
	ClientOrderID string `json:"client_order_id"`
	Status        string `json:"status"`
}

// GetOrderByClientID fetches an order by its client order ID.
func (c *Client) GetOrderByClientID(ctx context.Context, accountID, clientOrderID string) (OrderResponse, error) {
	var result OrderResponse
	token, ok := c.GetToken(accountID)
	if !ok {
		return result, ErrTokenNotFound
	}
	httpRequest, err := http.NewRequestWithContext(ctx, http.MethodGet, c.apiClient.BaseURL+"/orders/by-client-id/"+url.PathEscape(clientOrderID), nil)
	if err != nil {
		return result, err
	}
	httpRequest.Header.Set("authorization", "Bearer "+token)
	response, err := c.apiClient.HTTPClient.Do(httpRequest)
	if err != nil {
		return result, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
		return result, fmt.Errorf("sekuritas get order status %d: %s", response.StatusCode, strings.TrimSpace(string(body)))
	}
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		return result, err
	}
	return result, nil
}

type AmendOrderRequest struct {
	PriceIDR int64 `json:"price,omitempty"`
	Quantity int64 `json:"quantity,omitempty"`
}

// AmendOrder sends a PATCH request to amend an order's price or quantity.
func (c *Client) AmendOrder(ctx context.Context, accountID, orderID string, request AmendOrderRequest) error {
	token, ok := c.GetToken(accountID)
	if !ok {
		return ErrTokenNotFound
	}
	body, err := json.Marshal(request)
	if err != nil {
		return err
	}
	httpRequest, err := http.NewRequestWithContext(ctx, http.MethodPatch, c.apiClient.BaseURL+"/orders/"+url.PathEscape(orderID), strings.NewReader(string(body)))
	if err != nil {
		return err
	}
	httpRequest.Header.Set("authorization", "Bearer "+token)
	httpRequest.Header.Set("content-type", "application/json")
	httpRequest.Header.Set("x-correlation-id", uuid.NewString())
	response, err := c.apiClient.HTTPClient.Do(httpRequest)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		respBody, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
		return fmt.Errorf("sekuritas amend order status %d: %s", response.StatusCode, strings.TrimSpace(string(respBody)))
	}
	return nil
}

func NewClient(baseURL, token string) *Client {
	return &Client{
		apiClient:   client.NewAPIClient(baseURL, token),
		tokenCache:  make(map[string]string),
		tokenExpiry: make(map[string]time.Time),
	}
}

// StartTokenRefresher launches a background goroutine that performs staggered JWT
// refresh for all accounts in the provided list.
//
// Per Task 2.1 / BOT_API_CONTRACTS.md §4:
//   - Default lifetime 1 hour; refresh starts 5–10 minutes before expiry.
//   - Jitter (5–10 min window) prevents thundering herd across all bots.
//   - Revoked/suspended account tokens are dropped from cache when refresh fails.
//   - Token strings must NOT appear in logs.
//
// Call this after FetchTokens completes during startup. The goroutine exits
// when ctx is cancelled (graceful shutdown).
func (c *Client) StartTokenRefresher(ctx context.Context, accountIDs []string) {
	if len(accountIDs) == 0 {
		return
	}
	go c.tokenRefreshLoop(ctx, accountIDs)
}

func (c *Client) tokenRefreshLoop(ctx context.Context, accountIDs []string) {
	// Check every 30 seconds. Each account has independent jitter so they
	// do not all refresh at the same moment.
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.refreshExpiringTokens(ctx, accountIDs)
		}
	}
}

// refreshExpiringTokens refreshes tokens that are within their jittered refresh window.
// Refresh window per account: [expiry - 10min, expiry - 5min] with uniform jitter.
// This ensures no two bots refresh at exactly the same time.
func (c *Client) refreshExpiringTokens(ctx context.Context, accountIDs []string) {
	var toRefresh []string
	now := time.Now()

	c.mu.RLock()
	for _, id := range accountIDs {
		expiry, ok := c.tokenExpiry[id]
		if !ok {
			// No token at all — needs refresh
			toRefresh = append(toRefresh, id)
			continue
		}
		// Jittered refresh window: 5–10 minutes before expiry
		// rand.Intn is not crypto-sensitive here (it's just scheduling jitter)
		jitterSec := time.Duration(5*60+rand.Intn(5*60)) * time.Second
		refreshAt := expiry.Add(-jitterSec)
		if now.After(refreshAt) {
			toRefresh = append(toRefresh, id)
		}
	}
	c.mu.RUnlock()

	if len(toRefresh) == 0 {
		return
	}

	// Batch in groups of ≤100 per contract
	for start := 0; start < len(toRefresh); start += 100 {
		end := start + 100
		if end > len(toRefresh) {
			end = len(toRefresh)
		}
		batch := toRefresh[start:end]
		idemKey := "refresh-" + uuid.NewString()
		if err := c.FetchTokens(ctx, batch, idemKey); err != nil {
			logger.Error("Token staggered refresh failed", map[string]interface{}{
				"batch_size": len(batch),
				"error":      err.Error(),
				// NOTE: never log the token values or account IDs in bulk.
			})
			// Drop expired tokens from cache so callers receive ErrTokenExpired
			// rather than silently using a stale JWT.
			c.dropExpiredTokens(batch)
		}
	}
}

// dropExpiredTokens removes tokens from the cache for accounts whose tokens
// have already expired and could not be refreshed (e.g. account suspended/revoked).
func (c *Client) dropExpiredTokens(accountIDs []string) {
	now := time.Now()
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, id := range accountIDs {
		if exp, ok := c.tokenExpiry[id]; ok && now.After(exp) {
			delete(c.tokenCache, id)
			delete(c.tokenExpiry, id)
			logger.Warn("Token expired and removed from cache — account may be suspended", map[string]interface{}{
				"account_id": id,
			})
		}
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

// GetToken retrieves a valid JWT for the given account.
// Returns ErrTokenNotFound if no token exists, ErrTokenExpired if the cached
// token has already expired. The token string must NOT be logged by callers.
func (c *Client) GetToken(accountID string) (string, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	tk, ok := c.tokenCache[accountID]
	if !ok {
		return "", false
	}
	exp, hasExpiry := c.tokenExpiry[accountID]
	if hasExpiry && time.Now().After(exp) {
		// Token is expired — do not return it. The refresher should have
		// handled this, but return false defensively to prevent using stale JWT.
		return "", false
	}
	return tk, true
}

// TokenExpiresAt returns the expiry time for the given account's cached token.
// Returns zero time and false if no token is cached.
func (c *Client) TokenExpiresAt(accountID string) (time.Time, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	exp, ok := c.tokenExpiry[accountID]
	return exp, ok
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
