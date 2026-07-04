package mats

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Mandala-Exchange/bot-v2/internal/logger"
	"nhooyr.io/websocket"
)

type Event struct {
	Type       string          `json:"type"`
	Symbol     string          `json:"symbol,omitempty"`
	OccurredAt time.Time       `json:"occurred_at"`
	Payload    json.RawMessage `json:"payload"`
}

type BidAsk struct {
	Price    string `json:"price"`
	Quantity string `json:"quantity"`
}

func (b *BidAsk) UnmarshalJSON(data []byte) error {
	var raw struct {
		Price    json.RawMessage `json:"price"`
		Quantity json.RawMessage `json:"quantity"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	b.Price = jsonScalarString(raw.Price)
	b.Quantity = jsonScalarString(raw.Quantity)
	return nil
}

type DepthPayload struct {
	Bids []BidAsk `json:"bids"`
	Asks []BidAsk `json:"asks"`
}

type LastPricePayload struct {
	Symbol string `json:"symbol"`
	Last   string `json:"last"`
}

func (p *LastPricePayload) UnmarshalJSON(data []byte) error {
	var raw struct {
		Symbol string          `json:"symbol"`
		Last   json.RawMessage `json:"last"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	p.Symbol = raw.Symbol
	p.Last = jsonScalarString(raw.Last)
	return nil
}

type MarketSummaryPayload struct {
	Symbol    string `json:"symbol"`
	Open      string `json:"open"`
	High      string `json:"high"`
	Low       string `json:"low"`
	Close     string `json:"close"`
	Last      string `json:"last"`
	Volume    string `json:"volume"`
	Value     string `json:"value"`
	Frequency string `json:"frequency"`
}

func (p *MarketSummaryPayload) UnmarshalJSON(data []byte) error {
	var raw struct {
		Symbol    string          `json:"symbol"`
		Open      json.RawMessage `json:"open"`
		High      json.RawMessage `json:"high"`
		Low       json.RawMessage `json:"low"`
		Close     json.RawMessage `json:"close"`
		Last      json.RawMessage `json:"last"`
		Volume    json.RawMessage `json:"volume"`
		Value     json.RawMessage `json:"value"`
		Frequency json.RawMessage `json:"frequency"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	p.Symbol = raw.Symbol
	p.Open = jsonScalarString(raw.Open)
	p.High = jsonScalarString(raw.High)
	p.Low = jsonScalarString(raw.Low)
	p.Close = jsonScalarString(raw.Close)
	p.Last = jsonScalarString(raw.Last)
	p.Volume = jsonScalarString(raw.Volume)
	p.Value = jsonScalarString(raw.Value)
	p.Frequency = jsonScalarString(raw.Frequency)
	return nil
}

func jsonScalarString(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		return text
	}
	return string(raw)
}

type SessionStatePayload struct {
	Status string `json:"status"`
}

type BestBidAskPayload struct {
	Symbol  string  `json:"symbol"`
	BestBid *BidAsk `json:"best_bid"`
	BestAsk *BidAsk `json:"best_ask"`
}

type SessionTimerPayload struct {
	Status string `json:"status"`
}

type MarketState struct {
	mu sync.RWMutex

	SessionSegment string
	LastPrices     map[string]string
	BestBids       map[string]string
	BestAsks       map[string]string
	DepthSnapshots map[string]DepthPayload
	Summaries      map[string]MarketSummaryPayload
	Signals        map[string]MarketSignal
	LastHeartbeat  time.Time
}

type MarketSignal struct {
	Symbol             string
	LastPrice          int64
	PreviousPrice      int64
	ShortReturn        float64
	Open               int64
	High               int64
	Low                int64
	Close              int64
	Volume             int64
	VolumeDelta        int64
	TradeCount         int64
	TradeCountDelta    int64
	BestBid            int64
	BestAsk            int64
	Spread             int64
	BidDepth           int64
	AskDepth           int64
	OrderBookImbalance float64
	LastUpdatedAt      time.Time
}

func NewMarketState() *MarketState {
	return &MarketState{
		LastPrices:     make(map[string]string),
		BestBids:       make(map[string]string),
		BestAsks:       make(map[string]string),
		DepthSnapshots: make(map[string]DepthPayload),
		Summaries:      make(map[string]MarketSummaryPayload),
		Signals:        make(map[string]MarketSignal),
	}
}

func (s *MarketState) GetSessionSegment() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.SessionSegment
}

func (s *MarketState) GetLastPrice(symbol string) string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.LastPrices[symbol]
}

func (s *MarketState) GetBestBidAsk(symbol string) (string, string) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.BestBids[symbol], s.BestAsks[symbol]
}

// GetSummary mengembalikan market summary untuk simbol tertentu.
// Kembalikan (summary, true) jika ada, atau (zero, false) jika belum tersedia.
func (s *MarketState) GetSummary(symbol string) (MarketSummaryPayload, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	summary, ok := s.Summaries[symbol]
	return summary, ok
}

func (s *MarketState) GetSignal(symbol string) (MarketSignal, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	signal, ok := s.Signals[symbol]
	return signal, ok
}

func (s *MarketState) IsSignalStale(symbol string, maxAge time.Duration) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	signal, ok := s.Signals[symbol]
	return !ok || signal.LastUpdatedAt.IsZero() || time.Since(signal.LastUpdatedAt) > maxAge
}

type Client struct {
	wsURL            string
	token            string
	symbols          []string
	state            *MarketState
	mu               sync.Mutex
	conn             *websocket.Conn
	cancel           context.CancelFunc
	done             chan struct{}
	eventSubscribers []chan Event
	subscribersMu    sync.RWMutex
}

func NewClient(wsURL, token string, symbols []string) *Client {
	return &Client{
		wsURL:   wsURL,
		token:   token,
		symbols: symbols,
		state:   NewMarketState(),
		done:    make(chan struct{}),
	}
}

func (c *Client) GetState() *MarketState {
	return c.state
}

// Subscribe returns a channel that receives parsed events
func (c *Client) Subscribe() chan Event {
	c.subscribersMu.Lock()
	defer c.subscribersMu.Unlock()
	ch := make(chan Event, 100)
	c.eventSubscribers = append(c.eventSubscribers, ch)
	return ch
}

func (c *Client) notifySubscribers(ev Event) {
	c.subscribersMu.RLock()
	defer c.subscribersMu.RUnlock()
	for _, ch := range c.eventSubscribers {
		select {
		case ch <- ev:
		default:
			// Buffer full, drop event to prevent blocking client
		}
	}
}

func (c *Client) Start(ctx context.Context) {
	runCtx, cancel := context.WithCancel(ctx)
	c.cancel = cancel

	go c.connectLoop(runCtx)
}

func (c *Client) Stop() {
	if c.cancel != nil {
		c.cancel()
	}
	c.mu.Lock()
	if c.conn != nil {
		c.conn.Close(websocket.StatusNormalClosure, "stopping MATS client")
	}
	c.mu.Unlock()

	// Close subscribers
	c.subscribersMu.Lock()
	for _, ch := range c.eventSubscribers {
		close(ch)
	}
	c.eventSubscribers = nil
	c.subscribersMu.Unlock()
}

func (c *Client) connectLoop(ctx context.Context) {
	u, err := url.Parse(c.wsURL)
	if err != nil {
		logger.Error("Invalid MATS WS URL", "url", c.wsURL, "error", err.Error())
		return
	}
	q := u.Query()
	q.Set("symbols", strings.Join(c.symbols, ","))
	u.RawQuery = q.Encode()

	backoff := 1 * time.Second

	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		logger.Info("Connecting to MATS WebSocket", "url", u.String())
		headers := http.Header{}
		if c.token != "" {
			headers.Set("x-service-token", c.token)
		}
		conn, _, err := websocket.Dial(ctx, u.String(), &websocket.DialOptions{HTTPHeader: headers})
		if err != nil {
			logger.Error("Failed to connect to MATS WS", "error", err.Error(), "retry_in", backoff.String())
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
				backoff *= 2
				if backoff > 30*time.Second {
					backoff = 30 * time.Second
				}
				continue
			}
		}

		c.mu.Lock()
		c.conn = conn
		c.mu.Unlock()

		backoff = 1 * time.Second // Reset backoff on success
		logger.Info("Connected to MATS WebSocket successfully")

		err = c.readLoop(ctx, conn)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			logger.Error("MATS WS connection lost", "error", err.Error())
		}

		c.mu.Lock()
		c.conn = nil
		c.mu.Unlock()
	}
}

func (c *Client) readLoop(ctx context.Context, conn *websocket.Conn) error {
	for {
		_, payload, err := conn.Read(ctx)
		if err != nil {
			return err
		}

		var ev Event
		if err := json.Unmarshal(payload, &ev); err != nil {
			logger.Error("Failed to unmarshal MATS event", "error", err.Error(), "payload", string(payload))
			continue
		}

		c.processEvent(ev)
		c.notifySubscribers(ev)
	}
}

func (c *Client) processEvent(ev Event) {
	c.state.mu.Lock()
	defer c.state.mu.Unlock()

	switch ev.Type {
	case "session_state":
		var p SessionStatePayload
		if err := json.Unmarshal(ev.Payload, &p); err == nil {
			c.state.SessionSegment = p.Status
		}
	case "session_timer":
		var p SessionTimerPayload
		if err := json.Unmarshal(ev.Payload, &p); err == nil && p.Status != "" {
			c.state.SessionSegment = p.Status
		}
	case "depth_snapshot":
		var p DepthPayload
		if err := json.Unmarshal(ev.Payload, &p); err == nil {
			c.state.DepthSnapshots[ev.Symbol] = p
			if len(p.Bids) > 0 {
				c.state.BestBids[ev.Symbol] = p.Bids[0].Price
			}
			if len(p.Asks) > 0 {
				c.state.BestAsks[ev.Symbol] = p.Asks[0].Price
			}
			c.updateDepthSignal(ev.Symbol, p, ev.OccurredAt)
		}
	case "best_bid_ask":
		var p BestBidAskPayload
		if err := json.Unmarshal(ev.Payload, &p); err == nil {
			symbol := ev.Symbol
			if symbol == "" {
				symbol = p.Symbol
			}
			if p.BestBid != nil {
				c.state.BestBids[symbol] = p.BestBid.Price
			} else {
				delete(c.state.BestBids, symbol)
			}
			if p.BestAsk != nil {
				c.state.BestAsks[symbol] = p.BestAsk.Price
			} else {
				delete(c.state.BestAsks, symbol)
			}
			c.updateBestBidAskSignal(symbol, p, ev.OccurredAt)
		}
	case "last_price":
		var p LastPricePayload
		if err := json.Unmarshal(ev.Payload, &p); err == nil {
			c.state.LastPrices[ev.Symbol] = p.Last
			c.updateLastPriceSignal(ev.Symbol, p.Last, ev.OccurredAt)
		}
	case "market_summary":
		var p MarketSummaryPayload
		if err := json.Unmarshal(ev.Payload, &p); err == nil {
			c.state.Summaries[ev.Symbol] = p
			c.updateSummarySignal(ev.Symbol, p, ev.OccurredAt)
		}
	case "heartbeat":
		c.state.LastHeartbeat = ev.OccurredAt
	case "order_status", "trade_tape", "iep_iev", "auction_order_status":
		// Valid public MATS events that do not mutate the BOT market cache yet.
	default:
		logger.Debug("Ignoring unsupported MATS event", "type", ev.Type)
	}
}

func (c *Client) updateLastPriceSignal(symbol, rawPrice string, occurredAt time.Time) {
	price, err := strconv.ParseInt(rawPrice, 10, 64)
	if err != nil || price <= 0 {
		return
	}
	signal := c.state.Signals[symbol]
	signal.Symbol = symbol
	if signal.LastPrice > 0 && signal.LastPrice != price {
		signal.PreviousPrice = signal.LastPrice
	}
	signal.LastPrice = price
	if signal.PreviousPrice > 0 {
		signal.ShortReturn = float64(price-signal.PreviousPrice) / float64(signal.PreviousPrice)
	}
	signal.LastUpdatedAt = eventTime(occurredAt)
	c.state.Signals[symbol] = signal
}

func (c *Client) updateSummarySignal(symbol string, summary MarketSummaryPayload, occurredAt time.Time) {
	signal := c.state.Signals[symbol]
	signal.Symbol = symbol
	volume, _ := strconv.ParseInt(summary.Volume, 10, 64)
	frequency, _ := strconv.ParseInt(summary.Frequency, 10, 64)
	signal.Open, _ = strconv.ParseInt(summary.Open, 10, 64)
	signal.High, _ = strconv.ParseInt(summary.High, 10, 64)
	signal.Low, _ = strconv.ParseInt(summary.Low, 10, 64)
	signal.Close, _ = strconv.ParseInt(summary.Close, 10, 64)
	if volume >= signal.Volume {
		signal.VolumeDelta = volume - signal.Volume
	}
	if frequency >= signal.TradeCount {
		signal.TradeCountDelta = frequency - signal.TradeCount
	}
	signal.Volume = volume
	signal.TradeCount = frequency
	last := summary.Last
	if last == "" {
		last = summary.Close
	}
	if last != "" {
		c.state.Signals[symbol] = signal
		c.updateLastPriceSignal(symbol, last, occurredAt)
		signal = c.state.Signals[symbol]
	}
	signal.LastUpdatedAt = eventTime(occurredAt)
	c.state.Signals[symbol] = signal
}

func (c *Client) updateDepthSignal(symbol string, depth DepthPayload, occurredAt time.Time) {
	signal := c.state.Signals[symbol]
	signal.Symbol = symbol
	signal.BidDepth = totalDepth(depth.Bids)
	signal.AskDepth = totalDepth(depth.Asks)
	if len(depth.Bids) > 0 {
		signal.BestBid, _ = strconv.ParseInt(depth.Bids[0].Price, 10, 64)
	}
	if len(depth.Asks) > 0 {
		signal.BestAsk, _ = strconv.ParseInt(depth.Asks[0].Price, 10, 64)
	}
	signal.Spread = spread(signal.BestBid, signal.BestAsk)
	signal.OrderBookImbalance = imbalance(signal.BidDepth, signal.AskDepth)
	signal.LastUpdatedAt = eventTime(occurredAt)
	c.state.Signals[symbol] = signal
}

func (c *Client) updateBestBidAskSignal(symbol string, payload BestBidAskPayload, occurredAt time.Time) {
	signal := c.state.Signals[symbol]
	signal.Symbol = symbol
	if payload.BestBid != nil {
		signal.BestBid, _ = strconv.ParseInt(payload.BestBid.Price, 10, 64)
	} else {
		signal.BestBid = 0
	}
	if payload.BestAsk != nil {
		signal.BestAsk, _ = strconv.ParseInt(payload.BestAsk.Price, 10, 64)
	} else {
		signal.BestAsk = 0
	}
	signal.Spread = spread(signal.BestBid, signal.BestAsk)
	signal.LastUpdatedAt = eventTime(occurredAt)
	c.state.Signals[symbol] = signal
}

func totalDepth(levels []BidAsk) int64 {
	var total int64
	for _, level := range levels {
		quantity, _ := strconv.ParseInt(level.Quantity, 10, 64)
		total += quantity
	}
	return total
}

func spread(bid, ask int64) int64 {
	if bid <= 0 || ask <= 0 || ask < bid {
		return 0
	}
	return ask - bid
}

func imbalance(bidDepth, askDepth int64) float64 {
	total := bidDepth + askDepth
	if total <= 0 {
		return 0
	}
	return float64(bidDepth-askDepth) / float64(total)
}

func eventTime(value time.Time) time.Time {
	if value.IsZero() {
		return time.Now()
	}
	return value
}
