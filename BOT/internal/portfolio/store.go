// Package portfolio implements the BOT's local portfolio cache.
//
// Architecture (BOT_STATE_MACHINES.md §12):
//   - Sekuritas is the source of truth for cash, positions, and orders.
//   - The BOT's local cache is an estimation that is periodically reconciled.
//   - Primary path: Sekuritas fat events (full account in payload) replace local state.
//   - Secondary path: thin events (order/settlement deltas) apply incremental transitions.
//   - Pre-reserve methods allow the BOT to track orders it has submitted but Sekuritas
//     has not yet confirmed, enabling accurate buying-power estimation.
//   - When a Sekuritas fat event arrives it overwrites any pre-reserve with authoritative values.
package portfolio

import (
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"sync"
	"time"
)

// ─── Sentinel errors ──────────────────────────────────────────────────────────

var (
	// ErrSequenceGap is returned by Apply when the incoming sequence is not
	// exactly lastSequence+1, indicating a gap that requires snapshot-and-replay.
	// Per BOT_STATE_MACHINES.md §11.
	ErrSequenceGap = errors.New("account event sequence gap")

	// ErrInsufficientFunds is returned by ReserveCashForBuy when the account's
	// available cash is less than the requested reservation.
	ErrInsufficientFunds = errors.New("insufficient available cash for reservation")

	// ErrInsufficientShares is returned by ReserveSharesForSell when the
	// account's available shares for the symbol are insufficient.
	ErrInsufficientShares = errors.New("insufficient available shares for reservation")

	// ErrTerminalOrder is returned when attempting to transition a local order
	// that is already in a terminal state (filled/cancelled/rejected/expired).
	// Per BOT_STATE_MACHINES.md §5.
	ErrTerminalOrder = errors.New("cannot transition terminal order")

	// ErrOrderNotFound is returned by GetLocalOrder when the clientOrderID is unknown.
	ErrOrderNotFound = errors.New("local order not found")

	// ErrOrderAlreadyTracked is returned by TrackLocalOrder when clientOrderID already exists.
	ErrOrderAlreadyTracked = errors.New("local order already tracked with this clientOrderID")
)

// ─── Local order state machine (BOT_STATE_MACHINES.md §5) ─────────────────────

// LocalOrderStatus represents the BOT's local view of an order's lifecycle.
// Terminal states: filled | cancelled | rejected | expired | expired_before_submit.
// Per BOT_STATE_MACHINES.md §5.
type LocalOrderStatus string

const (
	StatusDecisionCreated     LocalOrderStatus = "decision_created"
	StatusQueued              LocalOrderStatus = "queued"
	StatusSubmitting          LocalOrderStatus = "submitting"
	StatusSubmitUnknown       LocalOrderStatus = "submit_unknown"
	StatusOpen                LocalOrderStatus = "open"
	StatusPartiallyFilled     LocalOrderStatus = "partially_filled"
	StatusFilled              LocalOrderStatus = "filled"
	StatusCancelled           LocalOrderStatus = "cancelled"
	StatusRejected            LocalOrderStatus = "rejected"
	StatusExpired             LocalOrderStatus = "expired"
	StatusExpiredBeforeSubmit LocalOrderStatus = "expired_before_submit"
)

// IsTerminal returns true if the status is a terminal state.
// Per BOT_STATE_MACHINES.md §5: terminal order must not return to non-terminal.
func (s LocalOrderStatus) IsTerminal() bool {
	switch s {
	case StatusFilled, StatusCancelled, StatusRejected, StatusExpired, StatusExpiredBeforeSubmit:
		return true
	}
	return false
}

// LocalOrder tracks a BOT-submitted order through its local lifecycle.
// The ClientOrderID is stable across retries (BOT_API_CONTRACTS.md §8).
//
// Pre-reserve fields (PreReservedCashIDR, PreReservedShares) track the BOT's
// local reservation applied before Sekuritas confirmation. They are overwritten
// when the authoritative Sekuritas fat event arrives.
type LocalOrder struct {
	ClientOrderID     string
	OrderID           string // assigned by Sekuritas on acceptance; empty until then
	AccountID         string
	Symbol            string
	Side              string // "buy" | "sell"
	OrderType         string // "limit" | "market"
	PriceIDR          int64  // 0 for market orders
	OriginalQtyShares int64
	FilledQtyShares   int64
	Status            LocalOrderStatus
	EntityVersion     int64
	// Pre-reserve: applied locally before Sekuritas confirms.
	// Overwritten when Sekuritas fat event arrives (see ReserveCashForBuy).
	PreReservedCashIDR int64 // buy: estimated cash locked (price×qty + fee estimate)
	PreReservedShares  int64 // sell: shares locked
}

// RemainingQtyShares returns the unfilled quantity.
func (o *LocalOrder) RemainingQtyShares() int64 {
	return o.OriginalQtyShares - o.FilledQtyShares
}

// ─── Core account types ───────────────────────────────────────────────────────

// Cash tracks the three-state cash balance.
// Per BOT_STATE_MACHINES.md §6:
//
//	available → reserved (buy order accepted by Sekuritas)
//	reserved  → pending  (fill awaiting settlement)
//	pending   → settled  (settlement complete)
//
// Cancel/reject/expiry return unused reserved to available.
type Cash struct {
	AvailableIDR int64 `json:"available_idr,string"`
	ReservedIDR  int64 `json:"reserved_idr,string"`
	PendingIDR   int64 `json:"pending_idr,string"`
}

// TotalIDR returns the sum of all cash states.
func (c Cash) TotalIDR() int64 { return c.AvailableIDR + c.ReservedIDR + c.PendingIDR }

// Position tracks shares in three states.
// Per BOT_STATE_MACHINES.md §7:
//
//	Sell: available → reserved → pending_out → settled_out
//	Buy:  (cash reserved) → pending_shares → available (after settlement)
//
// AveragePriceIDR is kept in sync with Sekuritas snapshots/events.
// TotalCostIDR is the BOT's running cost basis (AveragePrice × AvailableShares)
// updated on settlement events; between settlements it may lag.
// It is not JSON-serialized and is re-initialized from AveragePriceIDR on Replace.
type Position struct {
	Symbol          string `json:"symbol"`
	AvailableShares int64  `json:"available_shares"`
	ReservedShares  int64  `json:"reserved_shares"`
	PendingShares   int64  `json:"pending_shares"`
	AveragePriceIDR int64  `json:"average_price_idr,string"`
	TotalCostIDR    int64  `json:"-"` // BOT cost basis; not from JSON
}

// WeightedAveragePrice returns the cost basis per share.
// Uses TotalCostIDR / AvailableShares when available; falls back to AveragePriceIDR.
func (p *Position) WeightedAveragePrice() int64 {
	if p.AvailableShares > 0 && p.TotalCostIDR > 0 {
		return p.TotalCostIDR / p.AvailableShares
	}
	return p.AveragePriceIDR
}

// applyBuySettlement updates cost basis on buy settlement.
// Per BOT_STATE_MACHINES.md §8: weighted average cost after settlement.
func (p *Position) applyBuySettlement(settledShares, settlePriceIDR int64) {
	if settledShares <= 0 {
		return
	}
	if settledShares > p.PendingShares {
		settledShares = p.PendingShares
	}
	p.PendingShares -= settledShares
	p.TotalCostIDR += settledShares * settlePriceIDR
	p.AvailableShares += settledShares
	if p.AvailableShares > 0 {
		p.AveragePriceIDR = p.TotalCostIDR / p.AvailableShares
	}
}

// OpenOrder is the Sekuritas-authoritative view of an open order.
// Used in Account snapshots and fat events.
type OpenOrder struct {
	OrderID              string `json:"order_id"`
	ClientOrderID        string `json:"client_order_id"`
	Symbol               string `json:"symbol"`
	Side                 string `json:"side"`
	Status               string `json:"status"`
	QuantityShares       int64  `json:"quantity_shares"`
	FilledQuantityShares int64  `json:"filled_quantity_shares"`
	EntityVersion        int64  `json:"entity_version"`
}

// Account is the BOT's local cache of a single Sekuritas account.
type Account struct {
	AccountID  string      `json:"account_id"`
	Cash       Cash        `json:"cash"`
	Positions  []Position  `json:"positions"`
	OpenOrders []OpenOrder `json:"open_orders"`
}

// Snapshot is the response from POST /api/v1/internal/bots/portfolio-snapshot.
// Per BOT_API_CONTRACTS.md §6.
type Snapshot struct {
	AsOfSequence int64     `json:"as_of_sequence"`
	GeneratedAt  time.Time `json:"generated_at"`
	Accounts     []Account `json:"accounts"`
}

// Event is the wire format for sequenced BOT account events.
// Per BOT_API_CONTRACTS.md §7.
type Event struct {
	EventID       string          `json:"event_id"`
	Sequence      int64           `json:"sequence"`
	AccountID     string          `json:"account_id"`
	EventType     string          `json:"event_type"`
	EntityID      string          `json:"entity_id"`
	EntityVersion int64           `json:"entity_version"`
	OccurredAt    time.Time       `json:"occurred_at"`
	CorrelationID string          `json:"correlation_id"`
	Payload       json.RawMessage `json:"payload"`
}

// ─── Internal payload structures ──────────────────────────────────────────────

// eventPayload is the union of possible event payload schemas.
// Sekuritas sends either fat events (full account) or thin events (order/settlement delta).
type eventPayload struct {
	Account    *Account         `json:"account"`
	Order      *orderDelta      `json:"order"`
	Settlement *settlementDelta `json:"settlement"`
	// Direct fields are the production Sekuritas settlement/corporate-action
	// wire format. Wrapped fields remain supported for backward compatibility.
	OrderID       string `json:"order_id"`
	AccountID     string `json:"account_id"`
	Symbol        string `json:"symbol"`
	Side          string `json:"side"`
	Quantity      int64  `json:"quantity"`
	PriceIDR      int64  `json:"price"`
	ActionType    string `json:"action_type"`
	AmountIDR     int64  `json:"amount"`
	QuantityDelta int64  `json:"quantity_delta"`
}

// orderDelta carries order-specific delta data for thin events.
// All IDR amounts use string decimal to avoid JSON float precision loss.
// Per BOT_API_CONTRACTS.md §8.
type orderDelta struct {
	OrderID        string `json:"order_id"`
	ClientOrderID  string `json:"client_order_id"`
	AccountID      string `json:"account_id"`
	Symbol         string `json:"symbol"`
	Side           string `json:"side"`       // "buy" | "sell"
	OrderType      string `json:"order_type"` // "limit" | "market"
	PriceIDR       int64  `json:"price_idr,string"`
	QuantityShares int64  `json:"quantity_shares"`
	FilledShares   int64  `json:"filled_quantity_shares"`
	// Cash deltas (Sekuritas-computed authoritative amounts)
	CashReservedIDR int64 `json:"cash_reserved_idr,string"` // available → reserved
	CashReleasedIDR int64 `json:"cash_released_idr,string"` // reserved → available (cancel/reject)
	CashPendingIDR  int64 `json:"cash_pending_idr,string"`  // reserved → pending (on fill)
	// Share deltas
	SharesReserved  int64 `json:"shares_reserved"`   // available → reserved (sell)
	SharesReleased  int64 `json:"shares_released"`   // reserved → available (cancel)
	SharesPendingIn int64 `json:"shares_pending_in"` // pending shares added (buy fill)
}

// settlementDelta carries settlement-specific data for thin settlement events.
type settlementDelta struct {
	AccountID      string `json:"account_id"`
	Symbol         string `json:"symbol"`
	Side           string `json:"side"` // "buy" | "sell"
	SharesSettled  int64  `json:"shares_settled"`
	CashSettledIDR int64  `json:"cash_settled_idr,string"` // sell: pending → available
	SettlePriceIDR int64  `json:"settle_price_idr,string"` // buy: for weighted average update
}

// ─── Store ────────────────────────────────────────────────────────────────────

// Store is the BOT's thread-safe local portfolio cache.
//
// Invariants (BOT_STATE_MACHINES.md §16):
//   - cash available/reserved/pending ≥ 0
//   - position available/reserved/pending ≥ 0
//   - event sequence checkpoint monotonic
//   - terminal orders do not revert
//
// The store does NOT enforce accounting invariants on Sekuritas fat events —
// Sekuritas is trusted as source of truth. Invariants are enforced on
// BOT-initiated pre-reserve operations (ReserveCashForBuy, ReserveSharesForSell).
type Store struct {
	mu           sync.RWMutex
	accounts     map[string]Account
	localOrders  map[string]*LocalOrder // clientOrderID → order (BOT's own decisions)
	orderVersion map[string]int64       // orderID → highest entity_version seen
	lastSequence int64
	seen         map[string]struct{} // eventID dedup
}

// NewStore creates an empty portfolio store.
func NewStore() *Store {
	return &Store{
		accounts:     make(map[string]Account),
		localOrders:  make(map[string]*LocalOrder),
		orderVersion: make(map[string]int64),
		seen:         make(map[string]struct{}),
	}
}

// Replace loads a fresh snapshot from Sekuritas, resetting the local account cache.
// Per BOT_STATE_MACHINES.md §11 (snapshot-and-replay procedure).
//
// Replace preserves localOrders so the BOT can reconcile its own order decisions
// against the fresh snapshot. Call after ErrSequenceGap or periodic reconciliation.
func (s *Store) Replace(snapshot Snapshot) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.accounts = make(map[string]Account, len(snapshot.Accounts))
	for _, acc := range snapshot.Accounts {
		cloned := cloneAccount(acc)
		initCostBasis(cloned.Positions)
		s.accounts[cloned.AccountID] = cloned
		// Index entity versions from open orders
		for _, o := range cloned.OpenOrders {
			if o.OrderID != "" && o.EntityVersion > s.orderVersion[o.OrderID] {
				s.orderVersion[o.OrderID] = o.EntityVersion
			}
		}
	}
	s.lastSequence = snapshot.AsOfSequence
	s.seen = make(map[string]struct{})
	
	// Garbage Collection (Anti Happy-Path):
	// Purge local orders that are already terminal, as their final state
	// is now fully represented in the fresh account snapshot. This prevents
	// unbounded memory growth (Memory Leak) for long-running bots.
	for clientOrderID, lo := range s.localOrders {
		if lo.Status.IsTerminal() {
			delete(s.localOrders, clientOrderID)
		}
	}
}

// Apply applies a sequenced Sekuritas account event to the local cache.
//
// Routing:
//   - Duplicate EventID → silently ignored (idempotent).
//   - Sequence ≤ lastSequence → silently ignored (at-least-once delivery).
//   - Sequence ≠ lastSequence+1 → ErrSequenceGap.
//   - Payload with "account" → fat event: full account replacement (primary, authoritative).
//   - Payload with "order" → thin event: incremental order transition.
//   - Payload with "settlement" → thin event: settlement transition + weighted avg.
//   - No/empty payload → sequence-only advance (e.g., account_suspended marker events).
//
// Returns ErrSequenceGap on gap. JSON decode errors are returned but still
// advance the sequence (to prevent replay loops; reconciliation will correct drift).
func (s *Store) Apply(event Event) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Duplicate EventID: idempotent ignore
	if _, dup := s.seen[event.EventID]; dup {
		return nil
	}
	// At-least-once: already covered by checkpoint
	if event.Sequence > 0 && event.Sequence <= s.lastSequence {
		return nil
	}
	// Gap detection (invariant: sequence monotonic)
	if event.Sequence != s.lastSequence+1 {
		return ErrSequenceGap
	}

	// Parse payload (empty or non-object payloads produce zero-value eventPayload)
	var payload eventPayload
	var decodeErr error
	if len(event.Payload) > 2 { // len > 2 means more than just "{}"
		decodeErr = json.Unmarshal(event.Payload, &payload)
	}

	if payload.Account != nil {
		// ── Fat event (primary path): full account replacement ──────────────
		s.applyFatEvent(payload.Account, event.EventType)
	} else if payload.Order != nil && decodeErr == nil {
		// ── Thin event: incremental order transition ─────────────────────────
		s.applyOrderDelta(event.EventType, payload.Order, event.EntityVersion)
	} else if payload.Settlement != nil && decodeErr == nil {
		// ── Thin event: settlement ───────────────────────────────────────────
		s.applySettlementDelta(payload.Settlement)
	} else if event.EventType == "settlement_completed" && decodeErr == nil {
		s.applySettlementDelta(&settlementDelta{
			AccountID: event.AccountID, Symbol: payload.Symbol, Side: payload.Side,
			SharesSettled: payload.Quantity, CashSettledIDR: payload.AmountIDR,
			SettlePriceIDR: payload.PriceIDR,
		})
	} else if event.EventType == "corporate_action_applied" && decodeErr == nil {
		s.applyCorporateAction(event.AccountID, payload.Symbol, payload.AmountIDR, payload.QuantityDelta, payload.PriceIDR)
	}
	// No payload or unrecognized structure: advance sequence only.

	// Update BOT's local order state from event type and entity_id
	if event.EntityID != "" {
		s.updateLocalOrderFromEvent(event)
	}

	s.seen[event.EventID] = struct{}{}
	s.lastSequence = event.Sequence
	return decodeErr
}

func (s *Store) applyCorporateAction(accountID, symbol string, cashDelta, quantityDelta, averagePriceIDR int64) {
	acc, ok := s.accounts[accountID]
	if !ok {
		return
	}
	if cashDelta != 0 {
		acc.Cash.AvailableIDR = clampNonNegative(acc.Cash.AvailableIDR + cashDelta)
	}
	if symbol != "" && quantityDelta != 0 {
		idx := findPositionIdx(acc.Positions, symbol)
		if idx < 0 && quantityDelta > 0 {
			acc.Positions = append(acc.Positions, Position{Symbol: symbol})
			idx = len(acc.Positions) - 1
		}
		if idx >= 0 {
			acc.Positions[idx].AvailableShares = clampNonNegative(acc.Positions[idx].AvailableShares + quantityDelta)
			if averagePriceIDR >= 0 {
				acc.Positions[idx].AveragePriceIDR = averagePriceIDR
				acc.Positions[idx].TotalCostIDR = averagePriceIDR * acc.Positions[idx].AvailableShares
			}
		}
	}
	s.accounts[accountID] = acc
}

// ─── Internal apply helpers ───────────────────────────────────────────────────

// applyFatEvent replaces the local account with Sekuritas-authoritative state.
// Also reconciles the entity version index and local order status.
func (s *Store) applyFatEvent(src *Account, eventType string) {
	cloned := cloneAccount(*src)
	// Preserve BOT cost basis if position unchanged; reinit if average price changed.
	if existing, ok := s.accounts[cloned.AccountID]; ok {
		mergeCostBasis(cloned.Positions, existing.Positions)
	} else {
		initCostBasis(cloned.Positions)
	}
	s.accounts[cloned.AccountID] = cloned
	// Sync entity version index from open orders
	for _, o := range cloned.OpenOrders {
		if o.OrderID != "" && o.EntityVersion > s.orderVersion[o.OrderID] {
			s.orderVersion[o.OrderID] = o.EntityVersion
		}
	}
	// Sync local orders: any clientOrderID not in open_orders and not yet
	// terminal locally may have been accepted or completed.
	s.syncLocalOrdersFromOpenOrders(cloned.AccountID, cloned.OpenOrders)
}

// applyOrderDelta applies an incremental order transition for thin events.
// Clamping is used instead of returning errors to avoid blocking sequence advance.
// Remaining drift is corrected by the periodic reconciliation (BOT_STATE_MACHINES.md §11).
func (s *Store) applyOrderDelta(eventType string, od *orderDelta, entityVersion int64) {
	acc, ok := s.accounts[od.AccountID]
	if !ok {
		return // account not yet loaded; ignore until snapshot loaded
	}
	// Entity version check: stale event version is ignored
	if od.OrderID != "" {
		if entityVersion > 0 && entityVersion <= s.orderVersion[od.OrderID] {
			return
		}
		if entityVersion > 0 {
			s.orderVersion[od.OrderID] = entityVersion
		}
	}

	switch eventType {
	case "order_accepted":
		if od.Side == "buy" {
			// available → reserved (BOT_STATE_MACHINES.md §6)
			reserved := clampMin(od.CashReservedIDR, 0)
			if reserved > acc.Cash.AvailableIDR {
				reserved = acc.Cash.AvailableIDR // clamp; reconciliation will correct
			}
			acc.Cash.AvailableIDR -= reserved
			acc.Cash.ReservedIDR += reserved
		} else {
			// sell: available_shares → reserved_shares (BOT_STATE_MACHINES.md §7)
			idx := findPositionIdx(acc.Positions, od.Symbol)
			if idx >= 0 {
				qty := clampMax(od.SharesReserved, acc.Positions[idx].AvailableShares)
				acc.Positions[idx].AvailableShares -= qty
				acc.Positions[idx].ReservedShares += qty
			}
		}

	case "order_rejected", "order_cancelled", "order_expired":
		// Release reservation back to available
		if od.CashReleasedIDR > 0 {
			released := clampMax(od.CashReleasedIDR, acc.Cash.ReservedIDR)
			acc.Cash.ReservedIDR -= released
			acc.Cash.AvailableIDR += released
		}
		if od.SharesReleased > 0 {
			idx := findPositionIdx(acc.Positions, od.Symbol)
			if idx >= 0 {
				qty := clampMax(od.SharesReleased, acc.Positions[idx].ReservedShares)
				acc.Positions[idx].ReservedShares -= qty
				acc.Positions[idx].AvailableShares += qty
			}
		}

	case "order_partially_filled", "order_filled":
		if od.Side == "buy" {
			// reserved → pending cash; add pending shares
			moved := clampMax(od.CashPendingIDR, acc.Cash.ReservedIDR)
			acc.Cash.ReservedIDR -= moved
			acc.Cash.PendingIDR += moved
			if od.SharesPendingIn > 0 {
				idx := findPositionIdx(acc.Positions, od.Symbol)
				if idx >= 0 {
					acc.Positions[idx].PendingShares += od.SharesPendingIn
				} else {
					acc.Positions = append(acc.Positions, Position{
						Symbol:        od.Symbol,
						PendingShares: od.SharesPendingIn,
					})
				}
			}
		} else {
			// sell: filled reserved_shares leave custody; pending cash added
			idx := findPositionIdx(acc.Positions, od.Symbol)
			if idx >= 0 {
				reduced := clampMax(od.FilledShares, acc.Positions[idx].ReservedShares)
				acc.Positions[idx].ReservedShares -= reduced
				// settled_out: shares leave; TotalCostIDR reduced proportionally
				if acc.Positions[idx].AvailableShares+acc.Positions[idx].ReservedShares+
					acc.Positions[idx].PendingShares > 0 {
					acc.Positions[idx].TotalCostIDR = acc.Positions[idx].AveragePriceIDR *
						(acc.Positions[idx].AvailableShares + acc.Positions[idx].PendingShares)
				}
			}
			acc.Cash.PendingIDR += od.CashPendingIDR
		}

	case "order_amended":
		if od.Side == "buy" {
			// Adjust cash reservation: new reserve may be higher or lower
			// CashReservedIDR = new total reservation for this order
			// CashReleasedIDR = excess reservation returned (if lowering)
			if od.CashReleasedIDR > 0 {
				released := clampMax(od.CashReleasedIDR, acc.Cash.ReservedIDR)
				acc.Cash.ReservedIDR -= released
				acc.Cash.AvailableIDR += released
			} else if od.CashReservedIDR > 0 {
				// Increasing reservation
				added := clampMin(od.CashReservedIDR, 0)
				if added > acc.Cash.AvailableIDR {
					added = acc.Cash.AvailableIDR
				}
				acc.Cash.AvailableIDR -= added
				acc.Cash.ReservedIDR += added
			}
		}
	}

	s.accounts[od.AccountID] = acc
}

// applySettlementDelta applies settlement accounting.
// Per BOT_STATE_MACHINES.md §6–8.
func (s *Store) applySettlementDelta(sd *settlementDelta) {
	acc, ok := s.accounts[sd.AccountID]
	if !ok {
		return
	}

	if sd.Side == "sell" {
		// Sell settlement: pending cash → available (BOT_STATE_MACHINES.md §6)
		settled := clampMax(sd.CashSettledIDR, acc.Cash.PendingIDR)
		acc.Cash.PendingIDR -= settled
		acc.Cash.AvailableIDR += settled

	} else if sd.Side == "buy" {
		// Buy settlement: pending_shares → available_shares + weighted avg update
		// (BOT_STATE_MACHINES.md §7–8)
		idx := findPositionIdx(acc.Positions, sd.Symbol)
		if idx >= 0 {
			acc.Positions[idx].applyBuySettlement(sd.SharesSettled, sd.SettlePriceIDR)
		} else if sd.SharesSettled > 0 {
			// New position created on first settlement
			acc.Positions = append(acc.Positions, Position{
				Symbol:          sd.Symbol,
				AvailableShares: sd.SharesSettled,
				AveragePriceIDR: sd.SettlePriceIDR,
				TotalCostIDR:    sd.SharesSettled * sd.SettlePriceIDR,
			})
		}
	}

	s.accounts[sd.AccountID] = acc
}

// syncLocalOrdersFromOpenOrders reconciles the BOT's localOrders against the
// Sekuritas-authoritative open orders list from a fat event.
// Orders not present in the open list that are tracked locally may have been
// filled, cancelled, or rejected — their local status is updated accordingly.
func (s *Store) syncLocalOrdersFromOpenOrders(accountID string, openOrders []OpenOrder) {
	// Build lookup of open order client IDs
	openClientIDs := make(map[string]struct{}, len(openOrders))
	for _, o := range openOrders {
		if o.ClientOrderID != "" {
			openClientIDs[o.ClientOrderID] = struct{}{}
		}
	}
	// Update entity versions and local order status
	for _, o := range openOrders {
		lo, ok := s.localOrders[o.ClientOrderID]
		if !ok {
			continue
		}
		if lo.Status.IsTerminal() {
			continue
		}
		// Sync filled quantity
		lo.FilledQtyShares = o.FilledQuantityShares
		if o.EntityVersion > lo.EntityVersion {
			lo.EntityVersion = o.EntityVersion
		}
		if o.OrderID != "" && lo.OrderID == "" {
			lo.OrderID = o.OrderID
		}
		// Update status based on Sekuritas open order status
		switch o.Status {
		case "open":
			if lo.FilledQtyShares == 0 {
				lo.Status = StatusOpen
			} else {
				lo.Status = StatusPartiallyFilled
			}
		case "partially_filled":
			lo.Status = StatusPartiallyFilled
		}
	}
	// Orders that are locally non-terminal but absent from Sekuritas open list
	// may be terminal; mark as submit_unknown for reconciliation lookup.
	for _, lo := range s.localOrders {
		if lo.AccountID != accountID || lo.Status.IsTerminal() {
			continue
		}
		if lo.Status == StatusOpen || lo.Status == StatusPartiallyFilled {
			if _, stillOpen := openClientIDs[lo.ClientOrderID]; !stillOpen {
				// Order disappeared from open list; treat as submit_unknown pending lookup
				lo.Status = StatusSubmitUnknown
			}
		}
	}
}

// updateLocalOrderFromEvent updates the local order matching event.EntityID
// based on the Sekuritas event type.
func (s *Store) updateLocalOrderFromEvent(event Event) {
	// EntityID may be the orderID; find matching local order
	var lo *LocalOrder
	for _, candidate := range s.localOrders {
		if candidate.OrderID == event.EntityID {
			lo = candidate
			break
		}
	}
	if lo == nil {
		return
	}
	if lo.Status.IsTerminal() {
		return // terminal state: do not revert (BOT_STATE_MACHINES.md §5)
	}
	switch event.EventType {
	case "order_accepted":
		lo.Status = StatusOpen
		if lo.OrderID == "" {
			lo.OrderID = event.EntityID
		}
	case "order_rejected":
		lo.Status = StatusRejected
	case "order_cancelled":
		lo.Status = StatusCancelled
	case "order_expired":
		lo.Status = StatusExpired
	case "order_partially_filled":
		lo.Status = StatusPartiallyFilled
	case "order_filled":
		lo.Status = StatusFilled
	case "order_amended":
		// Status remains the same; filled qty may have changed — updated via syncOpenOrders
	}
	if event.EntityVersion > lo.EntityVersion {
		lo.EntityVersion = event.EntityVersion
	}
}

// ─── Public query methods ─────────────────────────────────────────────────────

// LastSequence returns the highest sequence applied (monotonic checkpoint).
func (s *Store) LastSequence() int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.lastSequence
}

// Account returns a snapshot copy of the cached account.
func (s *Store) Account(id string) (Account, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	acc, ok := s.accounts[id]
	return cloneAccount(acc), ok
}

// Accounts returns all currently tracked account IDs.
func (s *Store) Accounts() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	ids := make([]string, 0, len(s.accounts))
	for id := range s.accounts {
		ids = append(ids, id)
	}
	return ids
}

// Compare returns accountIDs where the local cache does not match the snapshot.
// Does NOT mutate local state (BOT must not write corrections to Sekuritas).
// Per BOT_STATE_MACHINES.md §11: reconciliation direction is source-of-truth → BOT.
func (s *Store) Compare(snapshot Snapshot) []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var mismatches []string
	for _, expected := range snapshot.Accounts {
		actual, ok := s.accounts[expected.AccountID]
		if !ok || !equalAccount(actual, expected) {
			mismatches = append(mismatches, expected.AccountID)
		}
	}
	return mismatches
}

// ─── Local order management ────────────────────────────────────────────────────

// TrackLocalOrder registers a new BOT-submitted order for local tracking.
// Call after the strategy creates the order decision and before submission.
// Returns ErrOrderAlreadyTracked if the ClientOrderID already exists.
func (s *Store) TrackLocalOrder(order *LocalOrder) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.localOrders[order.ClientOrderID]; exists {
		return fmt.Errorf("%w: %s", ErrOrderAlreadyTracked, order.ClientOrderID)
	}
	clone := *order
	s.localOrders[order.ClientOrderID] = &clone
	return nil
}

// GetLocalOrder returns a copy of the tracked local order.
func (s *Store) GetLocalOrder(clientOrderID string) (LocalOrder, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	lo, ok := s.localOrders[clientOrderID]
	if !ok {
		return LocalOrder{}, false
	}
	return *lo, true
}

// UpdateLocalOrderStatus transitions a local order to a new status.
// Returns ErrTerminalOrder if the order is already in a terminal state.
// Returns ErrOrderNotFound if the clientOrderID is unknown.
func (s *Store) UpdateLocalOrderStatus(clientOrderID string, status LocalOrderStatus) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	lo, ok := s.localOrders[clientOrderID]
	if !ok {
		return fmt.Errorf("%w: %s", ErrOrderNotFound, clientOrderID)
	}
	if lo.Status.IsTerminal() {
		return fmt.Errorf("%w: %s is %s", ErrTerminalOrder, clientOrderID, lo.Status)
	}
	lo.Status = status
	return nil
}

// SetLocalOrderID assigns the Sekuritas order_id to a tracked local order.
// Call when Sekuritas accepts the order and returns an order_id.
func (s *Store) SetLocalOrderID(clientOrderID, orderID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	lo, ok := s.localOrders[clientOrderID]
	if !ok {
		return fmt.Errorf("%w: %s", ErrOrderNotFound, clientOrderID)
	}
	lo.OrderID = orderID
	return nil
}

// OpenLocalOrders returns all non-terminal local orders for the given accountID.
func (s *Store) OpenLocalOrders(accountID string) []LocalOrder {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var result []LocalOrder
	for _, lo := range s.localOrders {
		if lo.AccountID == accountID && !lo.Status.IsTerminal() {
			result = append(result, *lo)
		}
	}
	return result
}

// ─── Pre-reserve methods (BOT-side estimation) ────────────────────────────────

// ReserveCashForBuy moves cashIDR from available to reserved in the local cache
// to reflect a buy order that has been submitted but not yet confirmed by Sekuritas.
//
// This is an estimation for strategy pre-checks. When Sekuritas sends the
// authoritative fat event (order_accepted), it will overwrite this reservation
// with the official value.
//
// Returns ErrInsufficientFunds if available cash < cashIDR.
// Per BOT_STATE_MACHINES.md §6 and §9.
func (s *Store) ReserveCashForBuy(accountID string, cashIDR int64, clientOrderID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	acc, ok := s.accounts[accountID]
	if !ok {
		return fmt.Errorf("account not found: %s", accountID)
	}
	if cashIDR <= 0 {
		return fmt.Errorf("reservation cash must be positive")
	}
	if acc.Cash.AvailableIDR < cashIDR {
		return fmt.Errorf("%w: need %d, have %d", ErrInsufficientFunds, cashIDR, acc.Cash.AvailableIDR)
	}
	acc.Cash.AvailableIDR -= cashIDR
	acc.Cash.ReservedIDR += cashIDR
	s.accounts[accountID] = acc
	// Record pre-reserve on local order if tracked
	if lo, tracked := s.localOrders[clientOrderID]; tracked {
		lo.PreReservedCashIDR = cashIDR
	}
	return nil
}

// ReserveMarketBuy uses the BEI price-band upper bound plus an exact fee
// estimate. Sekuritas remains authoritative and may replace this pre-reserve.
func (s *Store) ReserveMarketBuy(accountID string, priceBandUpperIDR, quantityShares, estimatedFeeIDR int64, clientOrderID string) error {
	if priceBandUpperIDR <= 0 || quantityShares <= 0 || estimatedFeeIDR < 0 {
		return fmt.Errorf("invalid market reservation input")
	}
	total := new(big.Int).Mul(big.NewInt(priceBandUpperIDR), big.NewInt(quantityShares))
	total.Add(total, big.NewInt(estimatedFeeIDR))
	if !total.IsInt64() {
		return fmt.Errorf("market reservation overflow")
	}
	return s.ReserveCashForBuy(accountID, total.Int64(), clientOrderID)
}

// AmendCashReservation atomically changes a BOT-local buy pre-reservation.
func (s *Store) AmendCashReservation(accountID, clientOrderID string, newCashIDR int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if newCashIDR <= 0 {
		return fmt.Errorf("amended reservation must be positive")
	}
	lo, ok := s.localOrders[clientOrderID]
	if !ok {
		return fmt.Errorf("%w: %s", ErrOrderNotFound, clientOrderID)
	}
	if lo.Status.IsTerminal() {
		return ErrTerminalOrder
	}
	acc, ok := s.accounts[accountID]
	if !ok {
		return fmt.Errorf("account not found: %s", accountID)
	}
	delta := newCashIDR - lo.PreReservedCashIDR
	if delta > 0 {
		if acc.Cash.AvailableIDR < delta {
			return ErrInsufficientFunds
		}
		acc.Cash.AvailableIDR -= delta
		acc.Cash.ReservedIDR += delta
	} else if delta < 0 {
		release := clampMax(-delta, acc.Cash.ReservedIDR)
		acc.Cash.ReservedIDR -= release
		acc.Cash.AvailableIDR += release
	}
	lo.PreReservedCashIDR = newCashIDR
	s.accounts[accountID] = acc
	return nil
}

// AmendShareReservation atomically changes a BOT-local sell pre-reservation.
func (s *Store) AmendShareReservation(accountID, clientOrderID string, newQuantity int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if newQuantity <= 0 {
		return fmt.Errorf("amended quantity must be positive")
	}
	lo, ok := s.localOrders[clientOrderID]
	if !ok {
		return fmt.Errorf("%w: %s", ErrOrderNotFound, clientOrderID)
	}
	if lo.Status.IsTerminal() {
		return ErrTerminalOrder
	}
	acc, ok := s.accounts[accountID]
	if !ok {
		return fmt.Errorf("account not found: %s", accountID)
	}
	idx := findPositionIdx(acc.Positions, lo.Symbol)
	if idx < 0 {
		return ErrInsufficientShares
	}
	delta := newQuantity - lo.PreReservedShares
	if delta > 0 {
		if acc.Positions[idx].AvailableShares < delta {
			return ErrInsufficientShares
		}
		acc.Positions[idx].AvailableShares -= delta
		acc.Positions[idx].ReservedShares += delta
	} else if delta < 0 {
		release := clampMax(-delta, acc.Positions[idx].ReservedShares)
		acc.Positions[idx].ReservedShares -= release
		acc.Positions[idx].AvailableShares += release
	}
	lo.PreReservedShares = newQuantity
	s.accounts[accountID] = acc
	return nil
}

// ReserveSharesForSell moves qty shares from available to reserved in the local cache
// to reflect a sell order that has been submitted but not yet confirmed by Sekuritas.
//
// Returns ErrInsufficientShares if available shares < qty.
// Per BOT_STATE_MACHINES.md §7.
func (s *Store) ReserveSharesForSell(accountID, symbol string, qty int64, clientOrderID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	acc, ok := s.accounts[accountID]
	if !ok {
		return fmt.Errorf("account not found: %s", accountID)
	}
	if qty <= 0 {
		return fmt.Errorf("reservation quantity must be positive")
	}
	idx := findPositionIdx(acc.Positions, symbol)
	if idx < 0 || acc.Positions[idx].AvailableShares < qty {
		avail := int64(0)
		if idx >= 0 {
			avail = acc.Positions[idx].AvailableShares
		}
		return fmt.Errorf("%w: need %d %s, have %d", ErrInsufficientShares, qty, symbol, avail)
	}
	acc.Positions[idx].AvailableShares -= qty
	acc.Positions[idx].ReservedShares += qty
	s.accounts[accountID] = acc
	if lo, tracked := s.localOrders[clientOrderID]; tracked {
		lo.PreReservedShares = qty
	}
	return nil
}

// ReleaseReservation releases a pre-reserve for a local order that did not reach
// Sekuritas (e.g., expired_before_submit or local cancellation before submission).
//
// For orders that Sekuritas has confirmed, the reservation is released automatically
// via the authoritative fat event. This method is only for BOT-local cleanup.
func (s *Store) ReleaseReservation(accountID, clientOrderID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	lo, ok := s.localOrders[clientOrderID]
	if !ok {
		return fmt.Errorf("%w: %s", ErrOrderNotFound, clientOrderID)
	}
	acc, ok := s.accounts[accountID]
	if !ok {
		return fmt.Errorf("account not found: %s", accountID)
	}

	if lo.PreReservedCashIDR > 0 {
		released := clampMax(lo.PreReservedCashIDR, acc.Cash.ReservedIDR)
		acc.Cash.ReservedIDR -= released
		acc.Cash.AvailableIDR += released
		lo.PreReservedCashIDR = 0
	}
	if lo.PreReservedShares > 0 {
		idx := findPositionIdx(acc.Positions, lo.Symbol)
		if idx >= 0 {
			released := clampMax(lo.PreReservedShares, acc.Positions[idx].ReservedShares)
			acc.Positions[idx].ReservedShares -= released
			acc.Positions[idx].AvailableShares += released
		}
		lo.PreReservedShares = 0
	}
	lo.Status = StatusExpiredBeforeSubmit

	s.accounts[accountID] = acc
	return nil
}

// ─── Buying power estimation (BOT_STATE_MACHINES.md §6, §9) ──────────────────

// EstimateBuyingPower returns the available cash for new buy orders.
// This uses the local cache value, which reflects all pre-reserves applied since
// the last Sekuritas fat event. The official value always comes from Sekuritas.
func (s *Store) EstimateBuyingPower(accountID string) (int64, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	acc, ok := s.accounts[accountID]
	if !ok {
		return 0, false
	}
	return acc.Cash.AvailableIDR, true
}

// CanSell returns true if the account has ≥ qty available shares of symbol.
// BOT must not sell reserved_shares or pending_shares.
// Per BOT_STATE_MACHINES.md §7.
func (s *Store) CanSell(accountID, symbol string, qty int64) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	acc, ok := s.accounts[accountID]
	if !ok {
		return false
	}
	idx := findPositionIdx(acc.Positions, symbol)
	if idx < 0 {
		return false
	}
	return acc.Positions[idx].AvailableShares >= qty
}

// ─── Clone and equality helpers ───────────────────────────────────────────────

func cloneAccount(in Account) Account {
	out := in
	out.Positions = make([]Position, len(in.Positions))
	copy(out.Positions, in.Positions)
	out.OpenOrders = make([]OpenOrder, len(in.OpenOrders))
	copy(out.OpenOrders, in.OpenOrders)
	return out
}

func equalAccount(a, b Account) bool {
	if a.AccountID != b.AccountID || a.Cash != b.Cash {
		return false
	}
	if len(a.Positions) != len(b.Positions) || len(a.OpenOrders) != len(b.OpenOrders) {
		return false
	}
	// Position comparison: only public fields (TotalCostIDR is BOT-internal)
	for i := range a.Positions {
		ap, bp := a.Positions[i], b.Positions[i]
		if ap.Symbol != bp.Symbol || ap.AvailableShares != bp.AvailableShares ||
			ap.ReservedShares != bp.ReservedShares || ap.PendingShares != bp.PendingShares {
			return false
		}
	}
	for i := range a.OpenOrders {
		if a.OpenOrders[i] != b.OpenOrders[i] {
			return false
		}
	}
	return true
}

// initCostBasis initializes TotalCostIDR from AveragePriceIDR × AvailableShares.
func initCostBasis(positions []Position) {
	for i := range positions {
		positions[i].TotalCostIDR = positions[i].AveragePriceIDR * positions[i].AvailableShares
	}
}

// mergeCostBasis carries over the existing BOT cost basis to the new positions
// when AveragePriceIDR and AvailableShares are unchanged. Reinits if they changed
// (e.g., settlement event caused an update).
func mergeCostBasis(newPositions, existingPositions []Position) {
	existing := make(map[string]Position, len(existingPositions))
	for _, p := range existingPositions {
		existing[p.Symbol] = p
	}
	for i := range newPositions {
		p := &newPositions[i]
		if ep, ok := existing[p.Symbol]; ok && ep.TotalCostIDR > 0 {
			// If average price or available shares changed, reinit cost basis
			if p.AveragePriceIDR == ep.AveragePriceIDR && p.AvailableShares == ep.AvailableShares {
				p.TotalCostIDR = ep.TotalCostIDR // preserve running calculation
			} else {
				p.TotalCostIDR = p.AveragePriceIDR * p.AvailableShares
			}
		} else {
			p.TotalCostIDR = p.AveragePriceIDR * p.AvailableShares
		}
	}
}

// ─── Slice helpers ────────────────────────────────────────────────────────────

// findPositionIdx returns the index of the position for symbol, or -1.
func findPositionIdx(positions []Position, symbol string) int {
	for i := range positions {
		if positions[i].Symbol == symbol {
			return i
		}
	}
	return -1
}

// ─── Numeric helpers ──────────────────────────────────────────────────────────

// clampMax returns min(v, max) — used to prevent negative balances on clamping.
func clampMax(v, max int64) int64 {
	if v > max {
		return max
	}
	return v
}

// clampMin returns max(v, min).
func clampMin(v, min int64) int64 {
	if v < min {
		return min
	}
	return v
}

func clampNonNegative(v int64) int64 {
	if v < 0 {
		return 0
	}
	return v
}
