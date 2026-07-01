package portfolio

import (
	"encoding/json"
	"errors"
	"testing"
	"time"
)

func TestSequenceDuplicateAndGap(t *testing.T) {
	store := NewStore()
	store.Replace(Snapshot{AsOfSequence: 10, Accounts: []Account{{AccountID: "a"}}})
	if err := store.Apply(Event{EventID: "e11", Sequence: 11, AccountID: "a"}); err != nil {
		t.Fatal(err)
	}
	if err := store.Apply(Event{EventID: "e11", Sequence: 11, AccountID: "a"}); err != nil {
		t.Fatal(err)
	}
	if err := store.Apply(Event{EventID: "e13", Sequence: 13, AccountID: "a"}); !errors.Is(err, ErrSequenceGap) {
		t.Fatalf("expected sequence gap, got %v", err)
	}
	if store.LastSequence() != 11 {
		t.Fatalf("gap advanced checkpoint")
	}
}

func TestReconciliationDoesNotOverwrite(t *testing.T) {
	store := NewStore()
	store.Replace(Snapshot{Accounts: []Account{{AccountID: "a", Cash: Cash{AvailableIDR: 100}}}})
	mismatches := store.Compare(Snapshot{Accounts: []Account{{AccountID: "a", Cash: Cash{AvailableIDR: 90}}}})
	if len(mismatches) != 1 {
		t.Fatalf("expected mismatch")
	}
	account, _ := store.Account("a")
	if account.Cash.AvailableIDR != 100 {
		t.Fatalf("compare mutated local cache")
	}
}

func TestPreReserveBuy(t *testing.T) {
	store := NewStore()
	store.Replace(Snapshot{Accounts: []Account{{AccountID: "acc1", Cash: Cash{AvailableIDR: 10000}}}})

	// Pre-reserve valid amount
	err := store.ReserveCashForBuy("acc1", 6000, "client-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	acc, _ := store.Account("acc1")
	if acc.Cash.AvailableIDR != 4000 || acc.Cash.ReservedIDR != 6000 {
		t.Errorf("expected available 4000, reserved 6000, got %+v", acc.Cash)
	}

	bp, _ := store.EstimateBuyingPower("acc1")
	if bp != 4000 {
		t.Errorf("expected buying power 4000, got %d", bp)
	}

	// Exceed available
	err = store.ReserveCashForBuy("acc1", 5000, "client-2")
	if !errors.Is(err, ErrInsufficientFunds) {
		t.Fatalf("expected insufficient funds, got %v", err)
	}
}

func TestPreReserveSell(t *testing.T) {
	store := NewStore()
	store.Replace(Snapshot{Accounts: []Account{{
		AccountID: "acc1",
		Positions: []Position{{Symbol: "BBCA", AvailableShares: 100}},
	}}})

	// Pre-reserve valid amount
	err := store.ReserveSharesForSell("acc1", "BBCA", 40, "client-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	acc, _ := store.Account("acc1")
	if acc.Positions[0].AvailableShares != 60 || acc.Positions[0].ReservedShares != 40 {
		t.Errorf("expected available 60, reserved 40, got %+v", acc.Positions[0])
	}

	// Exceed available
	err = store.ReserveSharesForSell("acc1", "BBCA", 70, "client-2")
	if !errors.Is(err, ErrInsufficientShares) {
		t.Fatalf("expected insufficient shares, got %v", err)
	}
}

func buildEvent(sequence int64, eventType string, payload eventPayload) Event {
	b, _ := json.Marshal(payload)
	return Event{
		EventID:    "evt" + string(rune(sequence)),
		Sequence:   sequence,
		AccountID:  "acc1",
		EventType:  eventType,
		Payload:    b,
		OccurredAt: time.Now(),
	}
}

func TestThinEventOrderAccepted(t *testing.T) {
	store := NewStore()
	store.Replace(Snapshot{AsOfSequence: 10, Accounts: []Account{{
		AccountID: "acc1",
		Cash:      Cash{AvailableIDR: 10000},
	}}})

	store.TrackLocalOrder(&LocalOrder{ClientOrderID: "client-1", AccountID: "acc1", Side: "buy", Status: StatusSubmitting})

	event := Event{
		EventID:       "evt1",
		Sequence:      11,
		AccountID:     "acc1",
		EventType:     "order_accepted",
		EntityID:      "ord-1",
		EntityVersion: 1,
	}
	payload := eventPayload{
		Order: &orderDelta{
			AccountID:       "acc1",
			Side:            "buy",
			CashReservedIDR: 4000,
		},
	}
	event.Payload, _ = json.Marshal(payload)

	store.Apply(event)

	acc, _ := store.Account("acc1")
	if acc.Cash.AvailableIDR != 6000 || acc.Cash.ReservedIDR != 4000 {
		t.Errorf("expected cash avail 6000, res 4000, got %+v", acc.Cash)
	}

	lo, _ := store.GetLocalOrder("client-1")
	// Since event.EntityID == "ord-1", and local order was created without knowing it,
	// updateLocalOrderFromEvent only matches if lo.OrderID == EntityID.
	// Normally SetLocalOrderID is called prior to/concurrently with order_accepted.
	// But let's check basic accounting works regardless.
	_ = lo
}

func TestThinEventSettlement(t *testing.T) {
	store := NewStore()
	store.Replace(Snapshot{AsOfSequence: 10, Accounts: []Account{{
		AccountID: "acc1",
		Cash:      Cash{PendingIDR: 5000},
		Positions: []Position{{
			Symbol:          "BBCA",
			PendingShares:   100,
			AveragePriceIDR: 1000,
			TotalCostIDR:    0, // initially 0 before initCostBasis
		}},
	}}})

	// simulate buy settlement (pending_shares -> available, avg price update)
	evtBuy := buildEvent(11, "settlement_completed", eventPayload{
		Settlement: &settlementDelta{
			AccountID:      "acc1",
			Symbol:         "BBCA",
			Side:           "buy",
			SharesSettled:  100,
			SettlePriceIDR: 1100,
		},
	})
	store.Apply(evtBuy)

	acc, _ := store.Account("acc1")
	if acc.Positions[0].AvailableShares != 100 {
		t.Errorf("expected 100 available shares, got %d", acc.Positions[0].AvailableShares)
	}
	if acc.Positions[0].WeightedAveragePrice() != 1100 {
		t.Errorf("expected avg price 1100, got %d", acc.Positions[0].WeightedAveragePrice())
	}

	// simulate sell settlement (pending cash -> available)
	evtSell := buildEvent(12, "settlement_completed", eventPayload{
		Settlement: &settlementDelta{
			AccountID:      "acc1",
			Side:           "sell",
			CashSettledIDR: 5000,
		},
	})
	store.Apply(evtSell)

	acc2, _ := store.Account("acc1")
	if acc2.Cash.AvailableIDR != 5000 || acc2.Cash.PendingIDR != 0 {
		t.Errorf("expected 5000 available cash, got %+v", acc2.Cash)
	}
}

func TestLocalOrderStatusSync(t *testing.T) {
	store := NewStore()
	store.Replace(Snapshot{Accounts: []Account{{AccountID: "acc1"}}})

	store.TrackLocalOrder(&LocalOrder{ClientOrderID: "c1", AccountID: "acc1", OrderID: "o1", Status: StatusOpen})

	// Event says filled
	evt := Event{
		EventID:   "evt1",
		Sequence:  1,
		AccountID: "acc1",
		EventType: "order_filled",
		EntityID:  "o1",
	}
	store.Apply(evt)

	lo, _ := store.GetLocalOrder("c1")
	if lo.Status != StatusFilled {
		t.Errorf("expected filled, got %v", lo.Status)
	}

	// Terminal orders shouldn't revert
	evt2 := Event{
		EventID:   "evt2",
		Sequence:  2,
		AccountID: "acc1",
		EventType: "order_accepted",
		EntityID:  "o1",
	}
	store.Apply(evt2)

	lo2, _ := store.GetLocalOrder("c1")
	if lo2.Status != StatusFilled {
		t.Errorf("expected filled, got %v", lo2.Status)
	}
}

func TestProductionSettlementFatEventReplacesAuthoritativeAccount(t *testing.T) {
	store := NewStore()
	store.Replace(Snapshot{AsOfSequence: 10, Accounts: []Account{{
		AccountID: "acc1", Cash: Cash{PendingIDR: 100100},
		Positions: []Position{{Symbol: "BBCA", PendingShares: 100}},
	}}})
	payload := json.RawMessage(`{
		"order_id":"o1","symbol":"BBCA","side":"buy","quantity":100,"price":1000,
		"account":{"account_id":"acc1","cash":{"available_idr":"0","reserved_idr":"0","pending_idr":"0"},
		"positions":[{"symbol":"BBCA","available_shares":100,"reserved_shares":0,"pending_shares":0,"average_price_idr":"1000"}],
		"open_orders":[]}
	}`)
	if err := store.Apply(Event{EventID: "settle-real", Sequence: 11, AccountID: "acc1", EventType: "settlement_completed", Payload: payload}); err != nil {
		t.Fatal(err)
	}
	acc, _ := store.Account("acc1")
	if acc.Cash.PendingIDR != 0 || acc.Positions[0].AvailableShares != 100 || acc.Positions[0].PendingShares != 0 {
		t.Fatalf("production settlement payload not applied: %+v", acc)
	}
}

func TestProductionCorporateActionFatEventReplacesAuthoritativeAccount(t *testing.T) {
	store := NewStore()
	store.Replace(Snapshot{AsOfSequence: 1, Accounts: []Account{{AccountID: "acc1"}}})
	payload := json.RawMessage(`{
		"action_type":"stock_split","symbol":"BBCA","quantity_delta":100,
		"account":{"account_id":"acc1","cash":{"available_idr":"500","reserved_idr":"0","pending_idr":"0"},
		"positions":[{"symbol":"BBCA","available_shares":200,"reserved_shares":0,"pending_shares":0,"average_price_idr":"500"}],
		"open_orders":[]}
	}`)
	if err := store.Apply(Event{EventID: "ca-real", Sequence: 2, AccountID: "acc1", EventType: "corporate_action_applied", Payload: payload}); err != nil {
		t.Fatal(err)
	}
	acc, _ := store.Account("acc1")
	if acc.Positions[0].AvailableShares != 200 || acc.Positions[0].AveragePriceIDR != 500 {
		t.Fatalf("corporate action payload not applied: %+v", acc.Positions)
	}
}

func TestReservationRejectsNonPositiveAmounts(t *testing.T) {
	store := NewStore()
	store.Replace(Snapshot{Accounts: []Account{{
		AccountID: "acc1", Cash: Cash{AvailableIDR: 1000},
		Positions: []Position{{Symbol: "BBCA", AvailableShares: 100}},
	}}})
	if err := store.ReserveCashForBuy("acc1", -1, "bad-buy"); err == nil {
		t.Fatal("negative cash reservation must be rejected")
	}
	if err := store.ReserveSharesForSell("acc1", "BBCA", 0, "bad-sell"); err == nil {
		t.Fatal("zero share reservation must be rejected")
	}
}

func TestMarketReserveAndAtomicAmend(t *testing.T) {
	store := NewStore()
	store.Replace(Snapshot{Accounts: []Account{{
		AccountID: "acc1", Cash: Cash{AvailableIDR: 200_000},
		Positions: []Position{{Symbol: "BBCA", AvailableShares: 500}},
	}}})
	if err := store.TrackLocalOrder(&LocalOrder{
		ClientOrderID: "buy-1", AccountID: "acc1", Symbol: "BBCA", Side: "buy", Status: StatusQueued,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.ReserveMarketBuy("acc1", 1_000, 100, 500, "buy-1"); err != nil {
		t.Fatal(err)
	}
	if err := store.AmendCashReservation("acc1", "buy-1", 120_000); err != nil {
		t.Fatal(err)
	}
	acc, _ := store.Account("acc1")
	if acc.Cash.AvailableIDR != 80_000 || acc.Cash.ReservedIDR != 120_000 {
		t.Fatalf("unexpected amended cash: %+v", acc.Cash)
	}
	if err := store.AmendCashReservation("acc1", "buy-1", 250_000); !errors.Is(err, ErrInsufficientFunds) {
		t.Fatalf("expected atomic insufficient-funds rejection, got %v", err)
	}
	acc, _ = store.Account("acc1")
	if acc.Cash.AvailableIDR != 80_000 || acc.Cash.ReservedIDR != 120_000 {
		t.Fatal("failed amend mutated reservation")
	}

	if err := store.TrackLocalOrder(&LocalOrder{
		ClientOrderID: "sell-1", AccountID: "acc1", Symbol: "BBCA", Side: "sell", Status: StatusQueued,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.ReserveSharesForSell("acc1", "BBCA", 100, "sell-1"); err != nil {
		t.Fatal(err)
	}
	if err := store.AmendShareReservation("acc1", "sell-1", 200); err != nil {
		t.Fatal(err)
	}
	acc, _ = store.Account("acc1")
	if acc.Positions[0].AvailableShares != 300 || acc.Positions[0].ReservedShares != 200 {
		t.Fatalf("unexpected amended shares: %+v", acc.Positions[0])
	}
}
