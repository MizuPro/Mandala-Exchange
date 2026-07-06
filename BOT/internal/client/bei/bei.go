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
	ReferencePrice  int64    `json:"reference_price"`
	PreviousClose   int64    `json:"previous_close"`
}

func (s *Security) UnmarshalJSON(data []byte) error {
	var aux struct {
		Symbol          string      `json:"symbol"`
		Board           string      `json:"board"`
		Status          string      `json:"status"`
		ActiveNotations []string    `json:"active_notations"`
		ReferencePrice  interface{} `json:"reference_price"`
		PreviousClose   interface{} `json:"previous_close"`
	}
	if err := json.Unmarshal(data, &aux); err != nil {
		return err
	}
	s.Symbol = aux.Symbol
	s.Board = aux.Board
	s.Status = aux.Status
	s.ActiveNotations = aux.ActiveNotations
	s.ReferencePrice = ParseFlexInt64(aux.ReferencePrice)
	s.PreviousClose = ParseFlexInt64(aux.PreviousClose)
	return nil
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

// IPOLifecycle merepresentasikan satu event IPO publik dari BEI.
// Response dari GET /bot/ipo-lifecycle berbentuk { items: [...], as_of: "..." }.
type IPOLifecycle struct {
	ID                  string    `json:"id"`
	Version             int       `json:"version"`
	IssuerCode          string    `json:"issuer_code"`
	Symbol              string    `json:"symbol"`
	CompanyName         string    `json:"company_name"`
	Status              string    `json:"status"` // bookbuilding|subscription|allocation|listed|cancelled
	OfferedShares       int64     // via UnmarshalJSON
	OfferingPriceIDR    int64     // via UnmarshalJSON
	SubscriptionLotSize int64     // via UnmarshalJSON
	SubscriptionStart   time.Time `json:"subscription_start"`
	SubscriptionEnd     time.Time `json:"subscription_end"`
	ListingAt           time.Time `json:"listing_at"`
	IPOHypeScore        int       `json:"ipo_hype_score"`
	IPOArchetype        string    `json:"ipo_archetype"` // hot_ipo|normal_ipo|overpriced_ipo|quiet_ipo|failed_hype_ipo
	OversubRatio        float64   // via UnmarshalJSON
	FloatRatio          string    `json:"float_ratio"`       // low|medium|high
	SectorSentiment     string    `json:"sector_sentiment"`  // positive|neutral|negative
	ListingSentiment    string    `json:"listing_sentiment"` // high|medium|low
	FairValueInitial    int64     // via UnmarshalJSON
	FairValueConfidence string    `json:"fair_value_confidence"` // high|medium|low
	PublishedAt         time.Time `json:"published_at"`
	UpdatedAt           time.Time `json:"updated_at"`
}

func (i *IPOLifecycle) UnmarshalJSON(data []byte) error {
	var aux struct {
		ID                  string      `json:"id"`
		Version             int         `json:"version"`
		IssuerCode          string      `json:"issuer_code"`
		Symbol              string      `json:"symbol"`
		CompanyName         string      `json:"company_name"`
		Status              string      `json:"status"`
		OfferedShares       interface{} `json:"offered_shares"`
		OfferingPriceIDR    interface{} `json:"offering_price_idr"`
		SubscriptionLotSize interface{} `json:"subscription_lot_size"`
		SubscriptionStart   time.Time   `json:"subscription_start"`
		SubscriptionEnd     time.Time   `json:"subscription_end"`
		ListingAt           time.Time   `json:"listing_at"`
		IPOHypeScore        int         `json:"ipo_hype_score"`
		IPOArchetype        string      `json:"ipo_archetype"`
		OversubRatio        interface{} `json:"oversubscription_ratio"`
		FloatRatio          string      `json:"float_ratio"`
		SectorSentiment     string      `json:"sector_sentiment"`
		ListingSentiment    string      `json:"listing_sentiment"`
		FairValueInitial    interface{} `json:"fair_value_initial"`
		FairValueConfidence string      `json:"fair_value_confidence"`
		PublishedAt         time.Time   `json:"published_at"`
		UpdatedAt           time.Time   `json:"updated_at"`
	}
	if err := json.Unmarshal(data, &aux); err != nil {
		return err
	}
	i.ID = aux.ID
	i.Version = aux.Version
	i.IssuerCode = aux.IssuerCode
	i.Symbol = aux.Symbol
	i.CompanyName = aux.CompanyName
	i.Status = aux.Status
	i.OfferedShares = ParseFlexInt64(aux.OfferedShares)
	i.OfferingPriceIDR = ParseFlexInt64(aux.OfferingPriceIDR)
	i.SubscriptionLotSize = ParseFlexInt64(aux.SubscriptionLotSize)
	i.SubscriptionStart = aux.SubscriptionStart
	i.SubscriptionEnd = aux.SubscriptionEnd
	i.ListingAt = aux.ListingAt
	i.IPOHypeScore = aux.IPOHypeScore
	i.IPOArchetype = aux.IPOArchetype
	i.OversubRatio = ParseFlexFloat64(aux.OversubRatio)
	i.FloatRatio = aux.FloatRatio
	i.SectorSentiment = aux.SectorSentiment
	i.ListingSentiment = aux.ListingSentiment
	i.FairValueInitial = ParseFlexInt64(aux.FairValueInitial)
	i.FairValueConfidence = aux.FairValueConfidence
	i.PublishedAt = aux.PublishedAt
	i.UpdatedAt = aux.UpdatedAt
	return nil
}

// IPOLifecycleResponse adalah wrapper response dari GET /bot/ipo-lifecycle.
type IPOLifecycleResponse struct {
	Items []IPOLifecycle `json:"items"`
	AsOf  time.Time      `json:"as_of"`
}


type CorporateAction struct {
	Type               string  `json:"type"`
	RatioNumerator     int     `json:"ratio_numerator"`
	RatioDenominator   int     `json:"ratio_denominator"`
	CashAmountPerShare float64 `json:"cash_amount_per_share"`
}

type News struct {
	ID          string    `json:"id"`
	Title       string    `json:"title"`
	Body        string    `json:"body"`
	Symbol      string    `json:"symbol"`
	Sector      string    `json:"sector"`
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

// PollSecurities fetches only the active securities (fast poller)
func (c *Client) PollSecurities(ctx context.Context) ([]Security, error) {
	var securities []Security
	err := c.apiClient.DoRequest(ctx, "GET", "/bot/daftar-saham-aktif", nil, nil, &securities)
	if err != nil {
		logger.Error("Failed to fetch active securities from BEI", "error", err.Error())
		return nil, err
	}

	c.mu.Lock()
	c.snapshot.Securities = securities
	c.snapshot.SecuritiesAt = time.Now()
	c.mu.Unlock()

	return securities, nil
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

	// 4. IPO Lifecycle — response berbentuk { items: [...], as_of: "..." }
	var ipoResp IPOLifecycleResponse
	if err := c.apiClient.DoRequest(ctx, "GET", "/bot/ipo-lifecycle", nil, nil, &ipoResp); err == nil {
		c.mu.Lock()
		c.snapshot.IPOs = ipoResp.Items
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

// PollIPOLifecycle mengambil data IPO secara independen dari full reference poll.
// Dipanggil setiap 10-15 detik oleh scheduler ticker terpisah.
// Method ini TIDAK mengupdate snapshot internal — IPOManager yang bertanggung jawab
// memproses diff dan menentukan apakah snapshot perlu diupdate.
func (c *Client) PollIPOLifecycle(ctx context.Context) ([]IPOLifecycle, time.Time, error) {
	var resp IPOLifecycleResponse
	if err := c.apiClient.DoRequest(ctx, "GET", "/bot/ipo-lifecycle", nil, nil, &resp); err != nil {
		logger.Warn("PollIPOLifecycle failed", "error", err.Error())
		return nil, time.Time{}, err
	}
	return resp.Items, resp.AsOf, nil
}
