package rules

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
	"sync"
	"time"

	"mandala-exchange/mats/internal/bei"
	"mandala-exchange/mats/internal/domain"
)

var ErrRulesUnavailable = errors.New("rules unavailable")

type Cache struct {
	client *bei.Client

	mu              sync.RWMutex
	securities      map[string]bei.Security
	profiles        []bei.RuleProfile
	session         *bei.SessionTemplate
	refreshedAt     time.Time
	symbolOverrides map[string]string
	sessionOverride *domain.SessionStatus
}

func NewCache(client *bei.Client) *Cache {
	return &Cache{
		client:          client,
		securities:      make(map[string]bei.Security),
		symbolOverrides: make(map[string]string),
	}
}

func (c *Cache) Client() *bei.Client {
	return c.client
}

func (c *Cache) Refresh(ctx context.Context) error {
	securities, err := c.client.Securities(ctx)
	if err != nil {
		return fmt.Errorf("sync securities: %w", err)
	}
	profiles, err := c.client.Rules(ctx)
	if err != nil {
		return fmt.Errorf("sync rules: %w", err)
	}
	session, err := c.client.ActiveSession(ctx)
	if err != nil {
		return fmt.Errorf("sync active session: %w", err)
	}

	bySymbol := make(map[string]bei.Security, len(securities))
	for _, security := range securities {
		security.Symbol = strings.ToUpper(security.Symbol)
		bySymbol[security.Symbol] = security
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	c.securities = bySymbol
	c.profiles = profiles
	c.session = session
	c.refreshedAt = time.Now().UTC()
	return nil
}

func (c *Cache) Replace(securities []bei.Security, profiles []bei.RuleProfile, session *bei.SessionTemplate) {
	bySymbol := make(map[string]bei.Security, len(securities))
	for _, security := range securities {
		security.Symbol = strings.ToUpper(security.Symbol)
		bySymbol[security.Symbol] = security
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.securities = bySymbol
	c.profiles = profiles
	c.session = session
	c.refreshedAt = time.Now().UTC()
}

func (c *Cache) RefreshedAt() time.Time {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.refreshedAt
}

func (c *Cache) ActiveSessionStatus() domain.SessionStatus {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.session == nil {
		return ""
	}
	return c.session.Status
}

// ActiveSessionID returns the BEI session ID from the last successful sync.
// Returns an empty string if no session has been synced yet.
func (c *Cache) ActiveSessionID() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.session == nil {
		return ""
	}
	return c.session.ID
}

// ActiveSessionTemplate returns a copy of the current session template if any.
func (c *Cache) ActiveSessionTemplate() *bei.SessionTemplate {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.session == nil {
		return nil
	}
	clone := *c.session
	return &clone
}

func (c *Cache) SessionState() domain.SessionStatus {
	return c.ActiveSessionStatus()
}

func (c *Cache) ListedSymbols() []string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	symbols := make([]string, 0, len(c.securities))
	for s := range c.securities {
		symbols = append(symbols, s)
	}
	return symbols
}

func (c *Cache) ValidatePlace(req PlaceValidationRequest) string {
	c.mu.RLock()
	defer c.mu.RUnlock()

	if req.IsShortSell {
		return "short_selling_not_supported"
	}
	if req.IsMargin {
		return "margin_trading_not_supported"
	}
	if req.OrderType != domain.OrderTypeLimit && req.OrderType != domain.OrderTypeMarket {
		return "unsupported_order_type"
	}
	if req.Quantity <= 0 {
		return "quantity_must_be_positive"
	}
	if req.OrderType == domain.OrderTypeLimit && req.Price <= 0 {
		return "price_must_be_positive"
	}
	if c.session == nil || len(c.profiles) == 0 || len(c.securities) == 0 {
		return ErrRulesUnavailable.Error()
	}
	sessionStatus := c.sessionStatusLocked()
	if !allowsOrderEntry(sessionStatus) {
		return "market_not_open_for_order_entry"
	}
	if req.OrderType == domain.OrderTypeMarket && sessionStatus != domain.SessionContinuous {
		return "market_order_requires_continuous_session"
	}
	if sessionStatus == domain.SessionPostClosing && c.session != nil && !c.session.PostClosingEnabled {
		return "post_closing_not_enabled"
	}

	security, ok := c.securities[strings.ToUpper(req.Symbol)]
	if !ok {
		return "symbol_not_found"
	}
	if override, ok := c.symbolOverrides[strings.ToUpper(req.Symbol)]; ok && override != "" {
		return override
	}
	if security.Status != "listed" {
		return "symbol_" + security.Status
	}
	if security.MarketMechanism != "" && security.MarketMechanism != "regular" {
		return "unsupported_market_mechanism_" + security.MarketMechanism
	}
	for _, notation := range security.ActiveNotations {
		if notation.IsActive && (notation.Type == "suspend" || notation.Type == "special_monitoring") {
			return "symbol_" + notation.Type
		}
	}

	profile, ok := c.profileFor(security)
	if !ok {
		return "rule_profile_not_found"
	}

	lotSize := resolveLotSize(profile)
	if lotSize <= 0 {
		return "lot_size_rule_not_found"
	}
	if req.Quantity%lotSize != 0 {
		return "quantity_not_multiple_of_lot_size"
	}
	if req.OrderType == domain.OrderTypeMarket {
		if !validAutoRejection(req.Quantity, lotSize, int64(security.SharesOutstanding), profile.AutoRejectionRules) {
			return "auto_rejection_volume"
		}
		return ""
	}
	if !validTick(req.Price, profile.TickSizeRules) {
		return "price_not_valid_tick"
	}
	if !validPriceBand(req.Price, int64(security.ReferencePrice), profile.PriceBandRules) {
		return "price_outside_price_band"
	}
	if !validAutoRejection(req.Quantity, lotSize, int64(security.SharesOutstanding), profile.AutoRejectionRules) {
		return "auto_rejection_volume"
	}

	return ""
}

func (c *Cache) ValidateAmend(req AmendValidationRequest) string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.session == nil {
		return ErrRulesUnavailable.Error()
	}
	if c.sessionStatusLocked() == domain.SessionNonCancellation {
		return string(domain.OrderStatusLockedNonCancellable)
	}
	return ""
}

func (c *Cache) IsAuctionCollection() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	status := c.sessionStatusLocked()
	return status == domain.SessionOpeningAuction || status == domain.SessionClosingAuction
}

func (c *Cache) ReferencePrice(symbol string) int64 {
	c.mu.RLock()
	defer c.mu.RUnlock()
	security, ok := c.securities[strings.ToUpper(symbol)]
	if !ok {
		return 0
	}
	if security.ReferencePrice > 0 {
		return int64(security.ReferencePrice)
	}
	return int64(security.PreviousClose)
}

func (c *Cache) Snapshot() Snapshot {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return Snapshot{
		Securities:    len(c.securities),
		RuleProfiles:  len(c.profiles),
		SessionStatus: c.sessionStatusLocked(),
		RefreshedAt:   c.refreshedAt,
	}
}

func (c *Cache) SetSessionStatus(status domain.SessionStatus) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.sessionOverride = &status
	if c.session == nil {
		c.session = &bei.SessionTemplate{
			ID:       "manual",
			Name:     "Manual Override",
			Status:   status,
			IsActive: true,
		}
		return
	}
	c.session.Status = status
}

func (c *Cache) ClearSessionOverride() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.sessionOverride = nil
}

func (c *Cache) SuspendSymbol(symbol, reason string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if reason == "" {
		reason = "symbol_suspended"
	}
	c.symbolOverrides[strings.ToUpper(symbol)] = reason
}

func (c *Cache) ResumeSymbol(symbol string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.symbolOverrides, strings.ToUpper(symbol))
}

func (c *Cache) profileFor(security bei.Security) (bei.RuleProfile, bool) {
	for _, profile := range c.profiles {
		if profile.Board == security.Board && (profile.MarketSegment == "" || profile.MarketSegment == "regular") {
			return profile, true
		}
	}
	for _, profile := range c.profiles {
		if profile.IsDefault {
			return profile, true
		}
	}
	return bei.RuleProfile{}, false
}

func (c *Cache) sessionStatusLocked() domain.SessionStatus {
	if c.sessionOverride != nil {
		return *c.sessionOverride
	}
	if c.session == nil {
		return ""
	}
	return c.session.Status
}

type PlaceValidationRequest struct {
	Symbol      string
	Side        domain.Side
	OrderType   domain.OrderType
	Price       int64
	Quantity    int64
	IsShortSell bool
	IsMargin    bool
}

type AmendValidationRequest struct {
	OrderID string
}

type Snapshot struct {
	Securities    int                  `json:"securities"`
	RuleProfiles  int                  `json:"rule_profiles"`
	SessionStatus domain.SessionStatus `json:"session_status"`
	RefreshedAt   time.Time            `json:"refreshed_at"`
}

type SpecialNotationSnapshot struct {
	Symbol    string                `json:"symbol"`
	Notations []bei.SpecialNotation `json:"notations"`
}

func (c *Cache) SpecialNotations() []SpecialNotationSnapshot {
	c.mu.RLock()
	defer c.mu.RUnlock()
	snapshots := make([]SpecialNotationSnapshot, 0)
	for symbol, security := range c.securities {
		if len(security.ActiveNotations) == 0 {
			continue
		}
		snapshots = append(snapshots, SpecialNotationSnapshot{
			Symbol:    symbol,
			Notations: append([]bei.SpecialNotation(nil), security.ActiveNotations...),
		})
	}
	return snapshots
}

func resolveLotSize(profile bei.RuleProfile) int64 {
	if len(profile.LotSizeRules) == 0 {
		return 0
	}
	return profile.LotSizeRules[0].LotSize
}

func validTick(price int64, rules []bei.TickSizeRule) bool {
	for _, rule := range rules {
		minPrice := int64(rule.MinPrice)
		maxPrice := rule.MaxPrice.Value
		if price < minPrice {
			continue
		}
		if maxPrice > 0 && price > maxPrice {
			continue
		}
		tickSize := int64(rule.TickSize)
		return tickSize > 0 && price%tickSize == 0
	}
	return false
}

func validPriceBand(price, referencePrice int64, rules []bei.PriceBandRule) bool {
	if referencePrice <= 0 {
		return false
	}
	for _, rule := range rules {
		minRef := int64(rule.MinReferencePrice)
		maxRef := rule.MaxReferencePrice.Value
		if referencePrice < minRef {
			continue
		}
		if maxRef > 0 && referencePrice > maxRef {
			continue
		}
		upper := int64(math.Floor(float64(referencePrice) * (1 + float64(rule.ARAPercent)/100)))
		lower := int64(math.Ceil(float64(referencePrice) * (1 - float64(rule.ARBPercent)/100)))
		if minPrice := int64(rule.MinPrice); minPrice > 0 && lower < minPrice {
			lower = minPrice
		}
		return price >= lower && price <= upper
	}
	return false
}

func validAutoRejection(quantity, lotSize, sharesOutstanding int64, rules []bei.AutoRejectionRule) bool {
	if len(rules) == 0 {
		return true
	}
	lots := quantity / lotSize
	for _, rule := range rules {
		if rule.MaxLotsPerOrder > 0 && lots > rule.MaxLotsPerOrder {
			return false
		}
		percent := rule.MaxListedSharesPercent.Value
		if percent > 0 && sharesOutstanding > 0 {
			maxShares := int64(math.Floor(float64(sharesOutstanding) * percent / 100))
			if quantity > maxShares {
				return false
			}
		}
	}
	return true
}

func allowsOrderEntry(status domain.SessionStatus) bool {
	switch status {
	case domain.SessionContinuous, domain.SessionPostClosing, domain.SessionOpeningAuction, domain.SessionClosingAuction:
		return true
	default:
		return false
	}
}
