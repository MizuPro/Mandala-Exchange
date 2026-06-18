package bei

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"mandala-exchange/mats/internal/domain"
)

type Client struct {
	baseURL string
	token   string
	client  *http.Client
}

func NewClient(baseURL, token string) *Client {
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		token:   token,
		client:  &http.Client{Timeout: 10 * time.Second},
	}
}

type Security struct {
	Symbol            string            `json:"symbol"`
	Board             string            `json:"board"`
	Status            string            `json:"status"`
	MarketMechanism   string            `json:"market_mechanism"`
	ReferencePrice    domain.NumericInt `json:"reference_price"`
	PreviousClose     domain.NumericInt `json:"previous_close"`
	SharesOutstanding domain.NumericInt `json:"shares_outstanding"`
	ActiveNotations   []SpecialNotation `json:"active_notations"`
}

type SpecialNotation struct {
	Type     string `json:"type"`
	Note     string `json:"note"`
	IsActive bool   `json:"is_active"`
}

type RuleProfile struct {
	ID                 string              `json:"id"`
	Name               string              `json:"name"`
	Board              string              `json:"board"`
	MarketSegment      string              `json:"market_segment"`
	IsDefault          bool                `json:"is_default"`
	LotSizeRules       []LotSizeRule       `json:"lot_size_rules"`
	TickSizeRules      []TickSizeRule      `json:"tick_size_rules"`
	PriceBandRules     []PriceBandRule     `json:"price_band_rules"`
	AutoRejectionRules []AutoRejectionRule `json:"auto_rejection_rules"`
}

type LotSizeRule struct {
	LotSize int64 `json:"lot_size"`
}

type TickSizeRule struct {
	MinPrice domain.NumericInt     `json:"min_price"`
	MaxPrice domain.NullableNumericInt `json:"max_price"`
	TickSize domain.NumericInt     `json:"tick_size"`
}

type PriceBandRule struct {
	MinReferencePrice domain.NumericInt         `json:"min_reference_price"`
	MaxReferencePrice domain.NullableNumericInt  `json:"max_reference_price"`
	ARAPercent        domain.NumericFloat        `json:"ara_percent"`
	ARBPercent        domain.NumericFloat        `json:"arb_percent"`
	MinPrice          domain.NumericInt          `json:"min_price"`
}

type AutoRejectionRule struct {
	MaxLotsPerOrder        int64                      `json:"max_lots_per_order"`
	MaxListedSharesPercent domain.NullableNumericFloat `json:"max_listed_shares_percent"`
}

type SessionTemplate struct {
	ID                      string               `json:"id"`
	Name                    string               `json:"name"`
	Status                  domain.SessionStatus `json:"status"`
	SettlementMode          string               `json:"settlement_mode"`
	SettlementDelaySessions int                  `json:"settlement_delay_sessions"`
	PostClosingEnabled      bool                 `json:"post_closing_enabled"`
	IsActive                bool                 `json:"is_active"`
	Segments                []SessionSegment     `json:"segments"`
}

type SessionSegment struct {
	Sequence         int                  `json:"sequence"`
	Status           domain.SessionStatus `json:"status"`
	DurationSeconds  int                  `json:"duration_seconds"`
	AllowOrderEntry  bool                 `json:"allow_order_entry"`
	AllowCancelAmend bool                 `json:"allow_cancel_amend"`
}

type BrokerValidation struct {
	Valid  bool   `json:"valid"`
	Reason string `json:"reason"`
}

type TradeCapturePayload struct {
	MATSTradeID    string    `json:"matsTradeId"`
	SequenceNumber int64     `json:"sequenceNumber"`
	SessionID      string    `json:"sessionId"`
	Symbol         string    `json:"symbol"`
	Price          int64     `json:"price"`
	Quantity       int64     `json:"quantity"`
	BuyBrokerCode  string    `json:"buyBrokerCode"`
	SellBrokerCode string    `json:"sellBrokerCode"`
	BuyInvestorID  string    `json:"buyInvestorId"`
	SellInvestorID string    `json:"sellInvestorId"`
	BuyOrderID     string    `json:"buyOrderId"`
	SellOrderID    string    `json:"sellOrderId"`
	OccurredAt     time.Time `json:"occurredAt"`
	IdempotencyKey string    `json:"idempotencyKey"`
	SessionState   string    `json:"sessionState"`
	SecurityStatus string    `json:"securityStatus"`
	BuyBrokerState string    `json:"buyBrokerState"`
	SellBrokerState string   `json:"sellBrokerState"`
}

func (c *Client) Securities(ctx context.Context) ([]Security, error) {
	var securities []Security
	err := c.get(ctx, "/integration/mats/securities", &securities)
	return securities, err
}

func (c *Client) Rules(ctx context.Context) ([]RuleProfile, error) {
	var profiles []RuleProfile
	err := c.get(ctx, "/integration/mats/rules", &profiles)
	return profiles, err
}

func (c *Client) ActiveSession(ctx context.Context) (*SessionTemplate, error) {
	var session *SessionTemplate
	err := c.get(ctx, "/integration/mats/sessions/active", &session)
	return session, err
}

type UpdateSessionStatusPayload struct {
	SessionID          string               `json:"sessionId"`
	Status             domain.SessionStatus `json:"status"`
	ExpectedTradeCount int                  `json:"expectedTradeCount,omitempty"`
	FinalTradeSequence int64                `json:"finalTradeSequence,omitempty"`
}

func (c *Client) UpdateSessionStatus(ctx context.Context, sessionID string, status domain.SessionStatus) error {
	payload := UpdateSessionStatusPayload{
		SessionID: sessionID,
		Status:    status,
	}
	return c.post(ctx, "/integration/mats/sessions/active/status", payload, nil)
}

func (c *Client) UpdateSessionStatusWithFinality(ctx context.Context, sessionID string, status domain.SessionStatus, expectedTradeCount int, finalTradeSequence int64) error {
	payload := UpdateSessionStatusPayload{
		SessionID:          sessionID,
		Status:             status,
		ExpectedTradeCount: expectedTradeCount,
		FinalTradeSequence: finalTradeSequence,
	}
	return c.post(ctx, "/integration/mats/sessions/active/status", payload, nil)
}

func (c *Client) ValidateBroker(ctx context.Context, code string) (BrokerValidation, error) {
	var validation BrokerValidation
	err := c.get(ctx, "/brokers/"+strings.ToUpper(code)+"/validate", &validation)
	return validation, err
}

func (c *Client) CaptureTrade(ctx context.Context, payload TradeCapturePayload) error {
	return c.post(ctx, "/trades/capture", payload, nil)
}

func (c *Client) get(ctx context.Context, path string, target any) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+path, nil)
	if err != nil {
		return err
	}
	return c.do(request, target)
}

func (c *Client) post(ctx context.Context, path string, body any, target any) error {
	payload, err := json.Marshal(body)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	request.Header.Set("content-type", "application/json")
	return c.do(request, target)
}

func (c *Client) do(request *http.Request, target any) error {
	if c.token != "" {
		request.Header.Set("x-service-token", c.token)
	}
	response, err := c.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("bei returned %s for %s %s", response.Status, request.Method, request.URL.Path)
	}
	if target == nil {
		return nil
	}
	return json.NewDecoder(response.Body).Decode(target)
}
