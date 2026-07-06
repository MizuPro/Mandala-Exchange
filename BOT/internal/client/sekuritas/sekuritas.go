package sekuritas

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/Mandala-Exchange/bot-v2/internal/client"
	"github.com/Mandala-Exchange/bot-v2/internal/logger"
	"github.com/Mandala-Exchange/bot-v2/internal/portfolio"
	"github.com/google/uuid"
	"nhooyr.io/websocket"
)

var (
	ErrTokenNotFound      = errors.New("token not found")
	ErrTokenExpired       = errors.New("token expired")
	ErrOrderSubmitUnknown = errors.New("order submit outcome unknown")
)

type Client struct {
	apiClient       *client.APIClient
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
	RejectReason  string `json:"reject_reason,omitempty"`
}

type AmendOrderRequest struct {
	PriceIDR int64 `json:"price,omitempty"`
	Quantity int64 `json:"quantity,omitempty"`
}

type OrderResponse struct {
	ID            string `json:"id"`
	ClientOrderID string `json:"client_order_id"`
	Status        string `json:"status"`
}

func NewClient(baseURL, token string) *Client {
	return &Client{
		apiClient:   client.NewAPIClient(baseURL, token),
		tokenCache:  make(map[string]string),
		tokenExpiry: make(map[string]time.Time),
	}
}

// GetToken retrieves a cached JWT token for accountID
func (c *Client) GetToken(accountID string) (string, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	tk, ok := c.tokenCache[accountID]
	if !ok {
		return "", false
	}
	exp, okExp := c.tokenExpiry[accountID]
	if okExp && time.Now().After(exp) {
		return "", false
	}
	return tk, true
}

// PlaceOrder sends a limit or market order via Sekuritas
func (c *Client) PlaceOrder(ctx context.Context, accountID string, request PlaceOrderRequest) (PlaceOrderResponse, error) {
	var result PlaceOrderResponse
	token, ok := c.GetToken(accountID)
	if !ok {
		return result, ErrTokenNotFound
	}

	headers := map[string]string{
		"Authorization": "Bearer " + token,
	}

	// We pass through our retry-enabled client
	err := c.apiClient.DoRequest(ctx, "POST", "/bot/orders", request, headers, &result)
	if err != nil {
		// If error is network timeout, wrap in ErrOrderSubmitUnknown so executor can reconcile
		var apiErr *client.APIError
		if errors.As(err, &apiErr) {
			if apiErr.Status >= 500 {
				return result, fmt.Errorf("%w: %v", ErrOrderSubmitUnknown, err)
			}
			return result, err
		}
		// Network timeout / connection dropped
		return result, fmt.Errorf("%w: %v", ErrOrderSubmitUnknown, err)
	}

	return result, nil
}

// CancelOrder deletes an order by id
func (c *Client) CancelOrder(ctx context.Context, accountID, orderID string) error {
	token, ok := c.GetToken(accountID)
	if !ok {
		return ErrTokenNotFound
	}

	headers := map[string]string{
		"Authorization": "Bearer " + token,
	}

	path := fmt.Sprintf("/bot/orders/%s", url.PathEscape(orderID))
	return c.apiClient.DoRequest(ctx, "DELETE", path, nil, headers, nil)
}

// AmendOrder patches an order price/quantity
func (c *Client) AmendOrder(ctx context.Context, accountID, orderID string, request AmendOrderRequest) error {
	token, ok := c.GetToken(accountID)
	if !ok {
		return ErrTokenNotFound
	}

	headers := map[string]string{
		"Authorization": "Bearer " + token,
	}

	path := fmt.Sprintf("/bot/orders/%s", url.PathEscape(orderID))
	return c.apiClient.DoRequest(ctx, "PATCH", path, request, headers, nil)
}

// GetOrderByClientID looks up order state by client_order_id (crucial for reconcile)
func (c *Client) GetOrderByClientID(ctx context.Context, accountID, clientOrderID string) (OrderResponse, error) {
	var result OrderResponse
	token, ok := c.GetToken(accountID)
	if !ok {
		return result, ErrTokenNotFound
	}

	headers := map[string]string{
		"Authorization": "Bearer " + token,
	}

	path := fmt.Sprintf("/bot/orders/by-client-id/%s", url.PathEscape(clientOrderID))
	err := c.apiClient.DoRequest(ctx, "GET", path, nil, headers, &result)
	return result, err
}

// IPOSubscriptionResponse adalah response dari POST /bot/ipo/:id/subscribe
// dan GET /bot/ipo/subscriptions/:subscriptionId.
type IPOSubscriptionResponse struct {
	SubscriptionID    string    `json:"subscription_id"`
	IPOEventID        string    `json:"ipo_event_id"`
	Symbol            string    `json:"symbol"`
	Status            string    `json:"status"` // cash_reserved|submitted_to_bei|allocated|settled|cancelled|reversed|refunded
	RequestedShares   int64     `json:"requested_shares"`
	AllocatedShares   int64     `json:"allocated_shares"`
	ReservedCashIDR   string    `json:"reserved_cash_idr"`
	ActualDebitIDR    string    `json:"actual_debit_idr"`
	OfficialFeeIDR    string    `json:"official_fee_idr"`
	BeiSubscriptionID string    `json:"bei_subscription_id"`
	IdempotencyKey    string    `json:"idempotency_key"`
	EventVersion      int       `json:"event_version"`
	RetryScheduled    bool      `json:"retry_scheduled,omitempty"`
	CreatedAt         time.Time `json:"created_at"`
	UpdatedAt         time.Time `json:"updated_at"`
}

// IsActive mengembalikan true jika subscription masih dalam status non-final.
func (r *IPOSubscriptionResponse) IsActive() bool {
	switch r.Status {
	case "cash_reserved", "submitted_to_bei", "allocated":
		return true
	}
	return false
}

var (
	// ErrIPOSubscribeTerminal adalah error 4xx non-retryable (mis. bot tidak eligible,
	// subscription window sudah tutup). Tidak perlu retry.
	ErrIPOSubscribeTerminal = errors.New("IPO subscribe terminal error")
	// ErrIPOSubscribeUnknown terjadi saat network error, timeout, atau 5xx.
	// Bot WAJIB melakukan lookup sebelum mengirim request baru.
	ErrIPOSubscribeUnknown = errors.New("IPO subscribe outcome unknown — wajib reconcile")
)

// SubscribeIPO mengirim subscription IPO ke Sekuritas dengan idempotency key stabil.
// Response 201/202 berarti sukses; 202 dengan status cash_reserved berarti
// forward ke BEI sedang diretry — bot tidak perlu melakukan apa-apa.
func (c *Client) SubscribeIPO(ctx context.Context, accountID, ipoID string, shares int64, idempotencyKey string) (*IPOSubscriptionResponse, error) {
	var result IPOSubscriptionResponse
	token, ok := c.GetToken(accountID)
	if !ok {
		return nil, ErrTokenNotFound
	}

	headers := map[string]string{
		"Authorization":   "Bearer " + token,
		"Idempotency-Key": idempotencyKey,
	}
	payload := map[string]interface{}{
		"requested_shares": shares,
	}

	path := fmt.Sprintf("/bot/ipo/%s/subscribe", url.PathEscape(ipoID))
	err := c.apiClient.DoRequest(ctx, "POST", path, payload, headers, &result)
	if err != nil {
		var apiErr *client.APIError
		if errors.As(err, &apiErr) {
			if apiErr.Status >= 400 && apiErr.Status < 500 {
				// 4xx: terminal — mis. not_eligible, window_closed, already_subscribed
				return nil, fmt.Errorf("%w: status=%d %s", ErrIPOSubscribeTerminal, apiErr.Status, apiErr.Message)
			}
			// 5xx: outcome unknown, wajib reconcile
			return nil, fmt.Errorf("%w: status=%d", ErrIPOSubscribeUnknown, apiErr.Status)
		}
		// Network timeout / connection dropped: outcome unknown
		return nil, fmt.Errorf("%w: %v", ErrIPOSubscribeUnknown, err)
	}
	return &result, nil
}

// CancelIPOSubscription membatalkan subscription IPO yang masih aktif.
func (c *Client) CancelIPOSubscription(ctx context.Context, accountID, ipoID, subscriptionID string) error {
	token, ok := c.GetToken(accountID)
	if !ok {
		return ErrTokenNotFound
	}

	headers := map[string]string{
		"Authorization": "Bearer " + token,
	}

	path := fmt.Sprintf("/bot/ipo/%s/subscriptions/%s/cancel", url.PathEscape(ipoID), url.PathEscape(subscriptionID))
	return c.apiClient.DoRequest(ctx, "POST", path, nil, headers, nil)
}

// listIPOSubscriptionsResponse adalah wrapper untuk GET /bot/ipo/subscriptions.
type listIPOSubscriptionsResponse struct {
	Items []IPOSubscriptionResponse `json:"items"`
}

// ListIPOSubscriptions mengambil semua subscription IPO aktif milik bot ini.
// Digunakan untuk: startup recovery dan reconcile setelah timeout outcome unknown.
// Endpoint: GET /bot/ipo/subscriptions
func (c *Client) ListIPOSubscriptions(ctx context.Context, accountID string) ([]IPOSubscriptionResponse, error) {
	token, ok := c.GetToken(accountID)
	if !ok {
		return nil, ErrTokenNotFound
	}

	headers := map[string]string{
		"Authorization": "Bearer " + token,
	}

	var resp listIPOSubscriptionsResponse
	if err := c.apiClient.DoRequest(ctx, "GET", "/bot/ipo/subscriptions", nil, headers, &resp); err != nil {
		return nil, err
	}
	return resp.Items, nil
}

// GetIPOSubscription mengambil detail satu subscription berdasarkan subscriptionID.
// Digunakan setelah subscriptionID diketahui untuk verifikasi status terbaru.
// Endpoint: GET /bot/ipo/subscriptions/:subscriptionId
func (c *Client) GetIPOSubscription(ctx context.Context, accountID, subscriptionID string) (*IPOSubscriptionResponse, error) {
	token, ok := c.GetToken(accountID)
	if !ok {
		return nil, ErrTokenNotFound
	}

	headers := map[string]string{
		"Authorization": "Bearer " + token,
	}

	var result IPOSubscriptionResponse
	path := fmt.Sprintf("/bot/ipo/subscriptions/%s", url.PathEscape(subscriptionID))
	if err := c.apiClient.DoRequest(ctx, "GET", path, nil, headers, &result); err != nil {
		return nil, err
	}
	return &result, nil
}



// ─── ADMIN/INTERNAL OPERATIONS ───

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
	headers := map[string]string{
		"Idempotency-Key": idempotencyKey,
	}
	err := c.apiClient.DoRequest(ctx, "POST", "/bot/internal/provision", req, headers, &resp)
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
	if len(accountIDs) == 0 {
		return nil
	}

	batchSize := 100
	for start := 0; start < len(accountIDs); start += batchSize {
		end := start + batchSize
		if end > len(accountIDs) {
			end = len(accountIDs)
		}
		batch := accountIDs[start:end]
		batchIdempKey := fmt.Sprintf("%s-%d", idempotencyKey, start/batchSize)

		req := TokenBatchRequest{AccountIDs: batch}
		var resp TokenBatchResponse
		headers := map[string]string{
			"Idempotency-Key": batchIdempKey,
		}
		err := c.apiClient.DoRequest(ctx, "POST", "/bot/internal/tokens", req, headers, &resp)
		if err != nil {
			return err
		}

		c.mu.Lock()
		for _, tk := range resp.Tokens {
			c.tokenCache[tk.AccountID] = tk.Token
			c.tokenExpiry[tk.AccountID] = tk.ExpiresAt
		}
		c.mu.Unlock()
	}
	return nil
}

func (c *Client) TriggerGenesis(ctx context.Context, payload interface{}, idempotencyKey string) error {
	headers := map[string]string{
		"Idempotency-Key": idempotencyKey,
	}
	return c.apiClient.DoRequest(ctx, "POST", "/bot/internal/genesis", payload, headers, nil)
}

type SnapshotRequest struct {
	AccountIDs        []string `json:"account_ids"`
	IncludeOpenOrders bool     `json:"include_open_orders"`
}

func (c *Client) BulkSnapshot(ctx context.Context, accountIDs []string) (portfolio.Snapshot, error) {
	var finalSnapshot portfolio.Snapshot
	if len(accountIDs) == 0 {
		return finalSnapshot, nil
	}

	batchSize := 100
	for start := 0; start < len(accountIDs); start += batchSize {
		end := start + batchSize
		if end > len(accountIDs) {
			end = len(accountIDs)
		}
		batch := accountIDs[start:end]

		var batchResult portfolio.Snapshot
		headers := map[string]string{}
		err := c.apiClient.DoRequest(ctx, "POST", "/bot/internal/portfolio-snapshot", SnapshotRequest{AccountIDs: batch, IncludeOpenOrders: true}, headers, &batchResult)
		if err != nil {
			return finalSnapshot, err
		}

		if start == 0 {
			finalSnapshot.AsOfSequence = batchResult.AsOfSequence
			finalSnapshot.GeneratedAt = batchResult.GeneratedAt
		} else {
			if batchResult.AsOfSequence > finalSnapshot.AsOfSequence {
				finalSnapshot.AsOfSequence = batchResult.AsOfSequence
			}
		}
		finalSnapshot.Accounts = append(finalSnapshot.Accounts, batchResult.Accounts...)
	}

	return finalSnapshot, nil
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
	base.Path = strings.TrimRight(base.Path, "/") + "/bot/internal/events/ws"
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
	logger.Info("Connected to Sekuritas account event stream", "after_sequence", afterSequence)

	for {
		_, payload, err := conn.Read(ctx)
		if err != nil {
			return err
		}

		var event portfolio.Event
		if err := json.Unmarshal(payload, &event); err != nil {
			logger.Error("Decode account event failed", "error", err.Error())
			continue
		}

		if event.EventType == "heartbeat" {
			continue
		}

		if err := handler(event); err != nil {
			logger.Error("Event handler returned error", "error", err.Error())
			return err
		}
	}
}

func (c *Client) StreamConnected() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.streamConnected
}

func (c *Client) StartTokenRefresher(ctx context.Context, accountIDs []string) {
	if len(accountIDs) == 0 {
		return
	}
	go c.tokenRefreshLoop(ctx, accountIDs)
}

func (c *Client) tokenRefreshLoop(ctx context.Context, accountIDs []string) {
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

func (c *Client) refreshExpiringTokens(ctx context.Context, accountIDs []string) {
	var toRefresh []string
	now := time.Now()

	c.mu.RLock()
	for _, id := range accountIDs {
		expiry, ok := c.tokenExpiry[id]
		if !ok {
			toRefresh = append(toRefresh, id)
			continue
		}
		// Jittered refresh window: 5-10 minutes before expiry
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

	for start := 0; start < len(toRefresh); start += 100 {
		end := start + 100
		if end > len(toRefresh) {
			end = len(toRefresh)
		}
		batch := toRefresh[start:end]
		idemKey := "refresh-" + uuid.NewString()
		if err := c.FetchTokens(ctx, batch, idemKey); err != nil {
			logger.Error("Token staggered refresh failed", "batch_size", len(batch), "error", err.Error())
			c.dropExpiredTokens(batch)
		}
	}
}

func (c *Client) dropExpiredTokens(accountIDs []string) {
	now := time.Now()
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, id := range accountIDs {
		if exp, ok := c.tokenExpiry[id]; ok && now.After(exp) {
			delete(c.tokenCache, id)
			delete(c.tokenExpiry, id)
			logger.Warn("Token expired and removed from cache — account may be suspended", "account_id", id)
		}
	}
}
