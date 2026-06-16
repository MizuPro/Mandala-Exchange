package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"mandala-exchange/mats/internal/domain"
	"mandala-exchange/mats/internal/events"
	"mandala-exchange/mats/internal/matching"
	"mandala-exchange/mats/internal/orders"
	"mandala-exchange/mats/internal/persistence"
	"mandala-exchange/mats/internal/rules"
	"mandala-exchange/mats/internal/session"
)

type Handler struct {
	orders     *orders.Service
	engine     *matching.Engine
	rules      *rules.Cache
	store      persistence.Store
	session    *session.Controller
	dispatcher *events.Dispatcher
}

func NewHandler(orderService *orders.Service, engine *matching.Engine, rulesCache *rules.Cache, store persistence.Store, sessionController *session.Controller, dispatcher *events.Dispatcher) *Handler {
	return &Handler{
		orders:     orderService,
		engine:     engine,
		rules:      rulesCache,
		store:      store,
		session:    sessionController,
		dispatcher: dispatcher,
	}
}

func (h *Handler) Health(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	dbStatus := "ok"
	if err := h.store.Ping(ctx); err != nil {
		dbStatus = "error: " + err.Error()
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"service":  "mats",
		"status":   "ok",
		"database": dbStatus,
		"rules":    h.rules.Snapshot(),
	})
}

func (h *Handler) SyncBEI(w http.ResponseWriter, r *http.Request) {
	if err := h.rules.Refresh(r.Context()); err != nil {
		WriteError(w, http.StatusBadGateway, err.Error())
		return
	}
	h.publishSpecialNotations()
	WriteJSON(w, http.StatusOK, map[string]any{
		"synced": true,
		"rules":  h.rules.Snapshot(),
	})
}

func (h *Handler) publishSpecialNotations() {
	if h.dispatcher == nil {
		return
	}
	for _, notation := range h.rules.SpecialNotations() {
		h.dispatcher.PublishMarketData(notation.Symbol, "special_notation", notation)
	}
}

func (h *Handler) PlaceOrder(w http.ResponseWriter, r *http.Request) {
	var req orders.PlaceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		WriteError(w, http.StatusBadRequest, "invalid_json")
		return
	}
	applyHeaders(r, &req.IdempotencyKey, &req.CorrelationID)
	response, err := h.orders.Place(r.Context(), req)
	if err != nil {
		writeOrderError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, response)
}

func (h *Handler) AmendOrder(w http.ResponseWriter, r *http.Request) {
	var req orders.AmendRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		WriteError(w, http.StatusBadRequest, "invalid_json")
		return
	}
	req.OrderID = chi.URLParam(r, "orderId")
	applyHeaders(r, &req.IdempotencyKey, &req.CorrelationID)
	response, err := h.orders.Amend(r.Context(), req)
	if err != nil {
		writeOrderError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, response)
}

func (h *Handler) CancelOrder(w http.ResponseWriter, r *http.Request) {
	var req orders.CancelRequest
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&req)
	}
	req.OrderID = chi.URLParam(r, "orderId")
	applyHeaders(r, &req.IdempotencyKey, &req.CorrelationID)
	response, err := h.orders.Cancel(r.Context(), req)
	if err != nil {
		writeOrderError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, response)
}

func (h *Handler) GetOrder(w http.ResponseWriter, r *http.Request) {
	order, err := h.orders.Get(r.Context(), chi.URLParam(r, "orderId"))
	if err != nil {
		writeOrderError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, order)
}

func (h *Handler) BookSnapshot(w http.ResponseWriter, r *http.Request) {
	symbol := strings.ToUpper(chi.URLParam(r, "symbol"))
	WriteJSON(w, http.StatusOK, h.engine.Snapshot(symbol))
}

func (h *Handler) DeliveryEvents(w http.ResponseWriter, r *http.Request) {
	status := strings.TrimSpace(r.URL.Query().Get("status"))
	events, err := h.store.ListDeliveryEvents(r.Context(), status, 100)
	if err != nil {
		WriteError(w, http.StatusBadRequest, err.Error())
		return
	}
	WriteJSON(w, http.StatusOK, events)
}

func (h *Handler) SetSessionStatus(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Status domain.SessionStatus `json:"status"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		WriteError(w, http.StatusBadRequest, "invalid_json")
		return
	}
	if req.Status == "" {
		WriteError(w, http.StatusBadRequest, "status_required")
		return
	}
	h.session.SetStatus(r.Context(), req.Status)
	WriteJSON(w, http.StatusOK, map[string]any{"status": req.Status})
}

func (h *Handler) HaltMarket(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Reason string `json:"reason"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	h.session.HaltMarket(r.Context(), req.Reason)
	WriteJSON(w, http.StatusOK, map[string]any{"status": domain.SessionHalted})
}

func (h *Handler) ResumeMarket(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Status domain.SessionStatus `json:"status"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	h.session.ResumeMarket(r.Context(), req.Status)
	WriteJSON(w, http.StatusOK, map[string]any{"status": h.rules.ActiveSessionStatus()})
}

func (h *Handler) SuspendSymbol(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Reason string `json:"reason"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	symbol := strings.ToUpper(chi.URLParam(r, "symbol"))
	h.session.SuspendSymbol(r.Context(), symbol, req.Reason)
	WriteJSON(w, http.StatusOK, map[string]any{"symbol": symbol, "status": "suspended"})
}

func (h *Handler) ResumeSymbol(w http.ResponseWriter, r *http.Request) {
	symbol := strings.ToUpper(chi.URLParam(r, "symbol"))
	h.session.ResumeSymbol(r.Context(), symbol)
	WriteJSON(w, http.StatusOK, map[string]any{"symbol": symbol, "status": "resumed"})
}

func (h *Handler) ExpireOpenOrders(w http.ResponseWriter, r *http.Request) {
	expired, err := h.session.ExpireOpenOrders(r.Context())
	if err != nil {
		WriteError(w, http.StatusBadRequest, err.Error())
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"expired": len(expired), "orders": expired})
}

func (h *Handler) StartRandomClosing(w http.ResponseWriter, r *http.Request) {
	var req struct {
		MaxSeconds int `json:"max_seconds"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	delay := h.session.StartRandomClosing(req.MaxSeconds)
	WriteJSON(w, http.StatusOK, map[string]any{
		"status":        domain.SessionRandomClosing,
		"delay_seconds": delay,
	})
}

func (h *Handler) AuctionIndicative(w http.ResponseWriter, r *http.Request) {
	symbol := strings.ToUpper(chi.URLParam(r, "symbol"))
	WriteJSON(w, http.StatusOK, h.session.Indicative(symbol))
}

func (h *Handler) UncrossAuction(w http.ResponseWriter, r *http.Request) {
	symbol := strings.ToUpper(chi.URLParam(r, "symbol"))
	indicative, trades, orders, err := h.session.UncrossAuction(r.Context(), symbol)
	if err != nil {
		WriteError(w, http.StatusBadRequest, err.Error())
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"indicative": indicative,
		"trades":     trades,
		"orders":     orders,
	})
}

func applyHeaders(r *http.Request, idempotencyKey *string, correlationID *string) {
	if *idempotencyKey == "" {
		*idempotencyKey = strings.TrimSpace(r.Header.Get("idempotency-key"))
	}
	if *correlationID == "" {
		*correlationID = strings.TrimSpace(r.Header.Get("x-correlation-id"))
	}
}

func writeOrderError(w http.ResponseWriter, err error) {
	status := http.StatusBadRequest
	if errors.Is(err, matching.ErrOrderNotFound) {
		status = http.StatusNotFound
	}
	if strings.Contains(err.Error(), "unavailable") {
		status = http.StatusBadGateway
	}
	WriteError(w, status, err.Error())
}
