package bei

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"sync"
	"time"

	"github.com/Mandala-Exchange/bot-v2/internal/client"
	"github.com/Mandala-Exchange/bot-v2/internal/logger"
)

type Security struct {
	Symbol          string   `json:"symbol"`
	Board           string   `json:"board"`
	Status          string   `json:"status"`
	ActiveNotations []string `json:"active_notations"`
}

type TradingRuleProfile struct {
	ID                 string          `json:"id"`
	Name               string          `json:"name"`
	Board              string          `json:"board"`
	MarketSegment      string          `json:"market_segment"`
	IsDefault          bool            `json:"is_default"`
	Metadata           json.RawMessage `json:"metadata"`
	LotSizeRules       json.RawMessage `json:"lot_size_rules"`
	TickSizeRules      json.RawMessage `json:"tick_size_rules"`
	PriceBandRules     json.RawMessage `json:"price_band_rules"`
	AutoRejectionRules json.RawMessage `json:"auto_rejection_rules"`
}

type FeeSchedule struct {
	Name            string  `json:"name"`
	BrokerBuyRate   float64 `json:"broker_buy_rate"`
	BrokerSellRate  float64 `json:"broker_sell_rate"`
	ExchangeFeeRate float64 `json:"exchange_fee_rate"`
	VatRate         float64 `json:"vat_rate"`
}

func (f *FeeSchedule) UnmarshalJSON(data []byte) error {
	var aux struct {
		Name            string      `json:"name"`
		BrokerBuyRate   interface{} `json:"broker_buy_rate"`
		BrokerSellRate  interface{} `json:"broker_sell_rate"`
		ExchangeFeeRate interface{} `json:"exchange_fee_rate"`
		VatRate         interface{} `json:"vat_rate"`
	}
	if err := json.Unmarshal(data, &aux); err != nil {
		return err
	}
	f.Name = aux.Name
	f.BrokerBuyRate = ParseFlexFloat64(aux.BrokerBuyRate)
	f.BrokerSellRate = ParseFlexFloat64(aux.BrokerSellRate)
	f.ExchangeFeeRate = ParseFlexFloat64(aux.ExchangeFeeRate)
	f.VatRate = ParseFlexFloat64(aux.VatRate)
	return nil
}

func ParseFlexFloat64(val interface{}) float64 {
	switch v := val.(type) {
	case float64:
		return v
	case float32:
		return float64(v)
	case int64:
		return float64(v)
	case int:
		return float64(v)
	case string:
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return f
		}
	}
	return 0.0
}

type SessionState struct {
	ID                     string          `json:"id"`
	Status                 string          `json:"status"` // e.g. "pre_open", "continuous", etc
	CurrentSegmentSequence int             `json:"current_segment_sequence"`
	Segments               json.RawMessage `json:"segments"`
}

type IPOLifecycle struct {
	IssuerCode    string `json:"issuer_code"`
	OfferedShares int64  `json:"offered_shares"`
	OfferingPrice int64  `json:"offering_price"`
	Status        string `json:"status"`
}

func (i *IPOLifecycle) UnmarshalJSON(data []byte) error {
	var aux struct {
		IssuerCode    string      `json:"issuer_code"`
		OfferedShares interface{} `json:"offered_shares"`
		OfferingPrice interface{} `json:"offering_price"`
		Status        string      `json:"status"`
	}
	if err := json.Unmarshal(data, &aux); err != nil {
		return err
	}
	i.IssuerCode = aux.IssuerCode
	i.OfferedShares = ParseFlexInt64(aux.OfferedShares)
	i.OfferingPrice = ParseFlexInt64(aux.OfferingPrice)
	i.Status = aux.Status
	return nil
}

type CorporateAction struct {
	Type               string  `json:"type"`
	RatioNumerator     int     `json:"ratio_numerator"`
	RatioDenominator   int     `json:"ratio_denominator"`
	CashAmountPerShare float64 `json:"cash_amount_per_share"`
}

type News struct {
	Title       string    `json:"title"`
	Body        string    `json:"body"`
	Sentiment   string    `json:"sentiment"`
	Intensity   string    `json:"intensity"`
	PublishedAt time.Time `json:"published_at"`
}

type FairValue struct {
	Symbol     string  `json:"symbol"`
	FairValue  float64 `json:"fair_value"`
	Confidence string  `json:"confidence"`
}

func (f *FairValue) UnmarshalJSON(data []byte) error {
	var aux struct {
		Symbol     string      `json:"symbol"`
		FairValue  interface{} `json:"fair_value"`
		Confidence string      `json:"confidence"`
	}
	if err := json.Unmarshal(data, &aux); err != nil {
		return err
	}
	f.Symbol = aux.Symbol
	f.FairValue = ParseFlexFloat64(aux.FairValue)
	f.Confidence = aux.Confidence
	return nil
}

func ParseFlexInt64(val interface{}) int64 {
	switch v := val.(type) {
	case float64:
		return int64(v)
	case int64:
		return v
	case int:
		return int64(v)
	case string:
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return int64(f)
		}
	}
	return 0
}

type MarketRegime struct {
	GlobalRegime     string          `json:"global_regime"`
	SectorRegimes    json.RawMessage `json:"sector_regimes"`
	VolatilityRegime string          `json:"volatility_regime"`
}

type LiquidityProfile struct {
	Symbol          string `json:"symbol"`
	LiquidityLevel  string `json:"liquidity_level"`
	VolatilityLevel string `json:"volatility_level"`
	RetailInterest  string `json:"retail_interest"`
}

type Snapshot struct {
	Securities          []Security
	SecuritiesAt        time.Time
	Rules               []TradingRuleProfile
	RulesAt             time.Time
	Fees                []FeeSchedule
	FeesAt              time.Time
	Session             *SessionState
	SessionAt           time.Time
	IPOs                []IPOLifecycle
	IPOsAt              time.Time
	CorpActions         []CorporateAction
	CorpActionsAt       time.Time
	News                []News
	NewsAt              time.Time
	FairValues          []FairValue
	FairValuesAt        time.Time
	Regime              *MarketRegime
	RegimeAt            time.Time
	LiquidityProfiles   []LiquidityProfile
	LiquidityProfilesAt time.Time
}

type Client struct {
	apiClient *client.APIClient
	mu        sync.RWMutex
	snapshot  Snapshot
}

func NewClient(baseURL, token string) *Client {
	return &Client{
		apiClient: client.NewAPIClient(baseURL, token),
	}
}

// GetSnapshot retrieves the cached data copy
func (c *Client) GetSnapshot() Snapshot {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.snapshot
}

// IsSessionStale checks if session data is older than 10s
func (c *Client) IsSessionStale() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.snapshot.SessionAt.IsZero() || time.Since(c.snapshot.SessionAt) > 10*time.Second
}

// IsRulesStale checks if rules are older than 300s
func (c *Client) IsRulesStale() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.snapshot.RulesAt.IsZero() || time.Since(c.snapshot.RulesAt) > 300*time.Second
}

// IsFeesStale checks if fee schedule is older than 300s
func (c *Client) IsFeesStale() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.snapshot.FeesAt.IsZero() || time.Since(c.snapshot.FeesAt) > 300*time.Second
}

// PollSessionState fetches only the session status (fast poller)
func (c *Client) PollSessionState(ctx context.Context) (*SessionState, error) {
	var state SessionState
	err := c.apiClient.DoRequest(ctx, "GET", "/bot/session-state", nil, nil, &state)
	if err != nil {
		logger.Error("Failed to fetch session state from BEI", "error", err.Error())
		return nil, err
	}

	c.mu.Lock()
	c.snapshot.Session = &state
	c.snapshot.SessionAt = time.Now()
	c.mu.Unlock()

	return &state, nil
}

// PollAllState fetches all reference data endpoints (slow poller)
func (c *Client) PollAllState(ctx context.Context) error {
	now := time.Now()

	// 1. Daftar Saham Aktif
	var securities []Security
	if err := c.apiClient.DoRequest(ctx, "GET", "/bot/daftar-saham-aktif", nil, nil, &securities); err == nil {
		c.mu.Lock()
		c.snapshot.Securities = securities
		c.snapshot.SecuritiesAt = now
		c.mu.Unlock()
	} else {
		logger.Error("Failed to fetch active securities from BEI", "error", err.Error())
	}

	// 2. Trading Rules (critical)
	var rules []TradingRuleProfile
	if err := c.apiClient.DoRequest(ctx, "GET", "/bot/trading-rules", nil, nil, &rules); err == nil {
		c.mu.Lock()
		c.snapshot.Rules = rules
		c.snapshot.RulesAt = now
		c.mu.Unlock()
	} else {
		logger.Error("Failed to fetch trading rules from BEI", "error", err.Error())
		return fmt.Errorf("critical endpoint /bot/trading-rules failed: %w", err)
	}

	// 3. Fee Schedule (critical)
	var fees []FeeSchedule
	if err := c.apiClient.DoRequest(ctx, "GET", "/bot/fee-schedule", nil, nil, &fees); err == nil {
		c.mu.Lock()
		c.snapshot.Fees = fees
		c.snapshot.FeesAt = now
		c.mu.Unlock()
	} else {
		logger.Error("Failed to fetch fee schedule from BEI", "error", err.Error())
		return fmt.Errorf("critical endpoint /bot/fee-schedule failed: %w", err)
	}

	// 4. IPO Lifecycle
	var ipos []IPOLifecycle
	if err := c.apiClient.DoRequest(ctx, "GET", "/bot/ipo-lifecycle", nil, nil, &ipos); err == nil {
		c.mu.Lock()
		c.snapshot.IPOs = ipos
		c.snapshot.IPOsAt = now
		c.mu.Unlock()
	} else {
		logger.Warn("Failed to fetch ipo lifecycle from BEI", "error", err.Error())
	}

	// 5. Corporate Action
	var corpActions []CorporateAction
	if err := c.apiClient.DoRequest(ctx, "GET", "/bot/corporate-action-minimal", nil, nil, &corpActions); err == nil {
		c.mu.Lock()
		c.snapshot.CorpActions = corpActions
		c.snapshot.CorpActionsAt = now
		c.mu.Unlock()
	} else {
		logger.Warn("Failed to fetch corporate action from BEI", "error", err.Error())
	}

	// 6. News
	var news []News
	if err := c.apiClient.DoRequest(ctx, "GET", "/bot/news-module", nil, nil, &news); err == nil {
		c.mu.Lock()
		c.snapshot.News = news
		c.snapshot.NewsAt = now
		c.mu.Unlock()
	} else {
		logger.Warn("Failed to fetch news from BEI", "error", err.Error())
	}

	// 7. Fair Value
	var fairValues []FairValue
	if err := c.apiClient.DoRequest(ctx, "GET", "/bot/fair-value-module", nil, nil, &fairValues); err == nil {
		c.mu.Lock()
		c.snapshot.FairValues = fairValues
		c.snapshot.FairValuesAt = now
		c.mu.Unlock()
	} else {
		logger.Warn("Failed to fetch fair values from BEI", "error", err.Error())
	}

	// 8. Market Regime
	var regime MarketRegime
	if err := c.apiClient.DoRequest(ctx, "GET", "/bot/market-regime", nil, nil, &regime); err == nil {
		c.mu.Lock()
		c.snapshot.Regime = &regime
		c.snapshot.RegimeAt = now
		c.mu.Unlock()
	} else {
		logger.Warn("Failed to fetch market regime from BEI", "error", err.Error())
	}

	// 9. Liquidity Profile
	var profiles []LiquidityProfile
	if err := c.apiClient.DoRequest(ctx, "GET", "/bot/liquidity-profile", nil, nil, &profiles); err == nil {
		c.mu.Lock()
		c.snapshot.LiquidityProfiles = profiles
		c.snapshot.LiquidityProfilesAt = now
		c.mu.Unlock()
	} else {
		logger.Warn("Failed to fetch liquidity profile from BEI", "error", err.Error())
	}

	return nil
}
