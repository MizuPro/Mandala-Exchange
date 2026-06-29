package mats

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/Mandala-Exchange/BOT/internal/logger"
	"github.com/google/uuid"
	"nhooyr.io/websocket"
)

type Event struct {
	Type       string          `json:"type"`
	Sequence   int64           `json:"sequence"`
	Symbol     string          `json:"symbol"`
	OccurredAt time.Time       `json:"occurred_at"`
	Payload    json.RawMessage `json:"payload"`
}

type Client struct {
	wsURL         string
	token         string
	symbols       []string
	onEvent       func(Event)
	mu            sync.RWMutex
	conn          *websocket.Conn
	ready         bool
	lastSequence  int64
	lastHeartbeat time.Time
	snapshots     map[string]bool
}

func NewClient(wsURL, token string) *Client {
	return &Client{wsURL: wsURL, token: token, snapshots: make(map[string]bool)}
}

func (c *Client) Configure(symbols []string, handler func(Event)) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.symbols = append([]string(nil), symbols...)
	c.onEvent = handler
	c.snapshots = make(map[string]bool, len(symbols))
	c.ready = false
}

func (c *Client) Connect(ctx context.Context) error {
	backoff := 250 * time.Millisecond
	for {
		err := c.connectOnce(ctx)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		c.setDisconnected()
		logger.Warn("MATS WebSocket disconnected", map[string]interface{}{"error": err.Error()})
		timer := time.NewTimer(backoff)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
		if backoff < 8*time.Second {
			backoff *= 2
		}
	}
}

func (c *Client) connectOnce(ctx context.Context) error {
	endpoint, err := url.Parse(c.wsURL)
	if err != nil {
		return err
	}
	query := endpoint.Query()
	c.mu.RLock()
	query.Set("symbols", strings.Join(c.symbols, ","))
	c.mu.RUnlock()
	endpoint.RawQuery = query.Encode()
	headers := http.Header{}
	headers.Set("x-service-token", c.token)
	headers.Set("x-correlation-id", uuid.NewString())
	conn, resp, err := websocket.Dial(ctx, endpoint.String(), &websocket.DialOptions{HTTPHeader: headers})
	if err != nil {
		if resp != nil {
			return errors.New(resp.Status)
		}
		return err
	}
	c.mu.Lock()
	c.conn = conn
	c.snapshots = make(map[string]bool, len(c.symbols))
	c.mu.Unlock()
	defer conn.Close(websocket.StatusNormalClosure, "reconnect")
	conn.SetReadLimit(4 << 20)
	for {
		_, body, err := conn.Read(ctx)
		if err != nil {
			return err
		}
		var event Event
		if err := json.Unmarshal(body, &event); err != nil {
			return err
		}
		c.accept(event)
	}
}

func (c *Client) accept(event Event) {
	c.mu.Lock()
	if event.Type == "heartbeat" {
		c.lastHeartbeat = time.Now()
	}
	if event.Sequence > c.lastSequence {
		c.lastSequence = event.Sequence
	}
	if event.Type == "depth_snapshot" {
		c.snapshots[strings.ToUpper(event.Symbol)] = true
	}
	allSnapshots := len(c.symbols) > 0
	for _, symbol := range c.symbols {
		if !c.snapshots[strings.ToUpper(symbol)] {
			allSnapshots = false
			break
		}
	}
	if allSnapshots {
		c.ready = true
	}
	handler := c.onEvent
	c.mu.Unlock()
	if handler != nil {
		handler(event)
	}
}

func (c *Client) setDisconnected() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.conn = nil
	c.ready = false
}

func (c *Client) IsReady() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.ready && (c.lastHeartbeat.IsZero() || time.Since(c.lastHeartbeat) <= 30*time.Second)
}

func (c *Client) LastSequence() int64 {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.lastSequence
}
