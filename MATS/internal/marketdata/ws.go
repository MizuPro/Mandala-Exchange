package marketdata

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"mandala-exchange/mats/internal/domain"
)

type Event struct {
	Type       string    `json:"type"`
	Sequence   int64     `json:"sequence"`
	Symbol     string    `json:"symbol,omitempty"`
	OccurredAt time.Time `json:"occurred_at"`
	Payload    any       `json:"payload"`
}

type SnapshotProvider interface {
	Snapshot(symbol string) domain.BookSnapshot
}

type SessionProvider interface {
	SessionState() domain.SessionStatus
}

type Hub struct {
	mu               sync.RWMutex
	clients          map[*client]struct{}
	sequence         int64
	snapshotProvider SnapshotProvider
	sessionProvider  SessionProvider
}

type client struct {
	conn    *websocket.Conn
	symbols map[string]struct{}
	send    chan Event
}

func NewHub() *Hub {
	return &Hub{
		clients: make(map[*client]struct{}),
	}
}

func (h *Hub) SetProviders(snapshotProvider SnapshotProvider, sessionProvider SessionProvider) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.snapshotProvider = snapshotProvider
	h.sessionProvider = sessionProvider
}

func (h *Hub) Publish(event Event) {
	h.mu.Lock()
	h.sequence++
	event.Sequence = h.sequence
	if event.OccurredAt.IsZero() {
		event.OccurredAt = time.Now().UTC()
	}
	clients := make([]*client, 0, len(h.clients))
	for c := range h.clients {
		if event.Symbol == "" || len(c.symbols) == 0 {
			clients = append(clients, c)
			continue
		}
		if _, ok := c.symbols[strings.ToUpper(event.Symbol)]; ok {
			clients = append(clients, c)
		}
	}
	h.mu.Unlock()

	for _, c := range clients {
		select {
		case c.send <- event:
		default:
		}
	}
}

func (h *Hub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
	})
	if err != nil {
		return
	}

	c := &client{
		conn:    conn,
		symbols: parseSymbols(r.URL.Query().Get("symbols")),
		send:    make(chan Event, 32),
	}
	h.register(c)
	defer h.unregister(c)

	h.sendInitialSnapshots(c)
	h.writeLoop(r.Context(), c)
}

func (h *Hub) register(c *client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.clients[c] = struct{}{}
}

func (h *Hub) unregister(c *client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.clients, c)
	close(c.send)
	_ = c.conn.Close(websocket.StatusNormalClosure, "closed")
}

func (h *Hub) sendInitialSnapshots(c *client) {
	h.mu.RLock()
	snapshotProvider := h.snapshotProvider
	sessionProvider := h.sessionProvider
	h.mu.RUnlock()

	if sessionProvider != nil {
		c.send <- Event{
			Type:       "session_state",
			OccurredAt: time.Now().UTC(),
			Payload: map[string]any{
				"status": sessionProvider.SessionState(),
			},
		}
	}
	if snapshotProvider == nil {
		return
	}
	for symbol := range c.symbols {
		snapshot := snapshotProvider.Snapshot(symbol)
		c.send <- Event{
			Type:       "depth_snapshot",
			Symbol:     symbol,
			OccurredAt: time.Now().UTC(),
			Payload:    snapshot,
		}
	}
}

func (h *Hub) writeLoop(ctx context.Context, c *client) {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case event, ok := <-c.send:
			if !ok {
				return
			}
			if !writeEvent(ctx, c.conn, event) {
				return
			}
		case <-ticker.C:
			if !writeEvent(ctx, c.conn, Event{Type: "heartbeat", OccurredAt: time.Now().UTC(), Payload: map[string]string{"status": "ok"}}) {
				return
			}
		}
	}
}

func writeEvent(ctx context.Context, conn *websocket.Conn, event Event) bool {
	payload, err := json.Marshal(event)
	if err != nil {
		return true
	}
	writeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return conn.Write(writeCtx, websocket.MessageText, payload) == nil
}

func parseSymbols(raw string) map[string]struct{} {
	symbols := make(map[string]struct{})
	for _, part := range strings.Split(raw, ",") {
		symbol := strings.ToUpper(strings.TrimSpace(part))
		if symbol != "" {
			symbols[symbol] = struct{}{}
		}
	}
	return symbols
}
