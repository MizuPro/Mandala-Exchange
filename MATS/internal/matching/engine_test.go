package matching

import (
	"context"
	"testing"
	"time"

	"mandala-exchange/mats/internal/domain"
	"mandala-exchange/mats/internal/marketdata"
	"mandala-exchange/mats/internal/sequence"
)

func TestEngineMatchesByPriceTimePriority(t *testing.T) {
	ctx := context.Background()
	engine := NewEngine(sequence.NewAtomic(100), "SESSION-1", marketdata.NewSummaryStore())

	sellLate := testOrder("S2", domain.SideSell, 99, 100, 2)
	sellEarly := testOrder("S1", domain.SideSell, 99, 100, 1)
	if _, _, err := engine.Place(ctx, sellLate); err != nil {
		t.Fatal(err)
	}
	if _, _, err := engine.Place(ctx, sellEarly); err != nil {
		t.Fatal(err)
	}

	buy := testOrder("B1", domain.SideBuy, 100, 100, 3)
	trades, updated, err := engine.Place(ctx, buy)
	if err != nil {
		t.Fatal(err)
	}
	if len(trades) != 1 {
		t.Fatalf("expected 1 trade, got %d", len(trades))
	}
	if trades[0].SellOrderID != "S1" {
		t.Fatalf("expected earlier resting order S1 to match first, got %s", trades[0].SellOrderID)
	}
	if len(updated) != 1 || updated[0].Status != domain.OrderStatusFilled {
		t.Fatalf("expected resting order filled update, got %#v", updated)
	}
}

func TestEnginePartialFillLeavesRemainingOpen(t *testing.T) {
	ctx := context.Background()
	engine := NewEngine(sequence.NewAtomic(200), "SESSION-1", marketdata.NewSummaryStore())

	sell := testOrder("S1", domain.SideSell, 100, 300, 1)
	if _, _, err := engine.Place(ctx, sell); err != nil {
		t.Fatal(err)
	}

	buy := testOrder("B1", domain.SideBuy, 100, 100, 2)
	trades, updated, err := engine.Place(ctx, buy)
	if err != nil {
		t.Fatal(err)
	}
	if len(trades) != 1 {
		t.Fatalf("expected 1 trade, got %d", len(trades))
	}
	if trades[0].Quantity != 100 {
		t.Fatalf("expected trade quantity 100, got %d", trades[0].Quantity)
	}
	if buy.Status != domain.OrderStatusFilled {
		t.Fatalf("expected incoming buy filled, got %s", buy.Status)
	}
	if len(updated) != 1 {
		t.Fatalf("expected 1 resting update, got %d", len(updated))
	}
	if updated[0].Status != domain.OrderStatusPartiallyFilled || updated[0].RemainingQuantity != 200 {
		t.Fatalf("expected resting partially filled with 200 remaining, got %#v", updated[0])
	}
}

func TestEngineSelfTradePreventionCancelsNewestWithoutTrade(t *testing.T) {
	ctx := context.Background()
	engine := NewEngine(sequence.NewAtomic(300), "SESSION-1", marketdata.NewSummaryStore())
	sell := testOrder("S-STP", domain.SideSell, 100, 100, 1)
	sell.AccountID = "SAME-ACCOUNT"
	if _, _, err := engine.Place(ctx, sell); err != nil {
		t.Fatal(err)
	}
	buy := testOrder("B-STP", domain.SideBuy, 100, 100, 2)
	buy.AccountID = "SAME-ACCOUNT"
	trades, updated, err := engine.Place(ctx, buy)
	if err != nil {
		t.Fatal(err)
	}
	if len(trades) != 0 || len(updated) != 0 {
		t.Fatalf("self trade prevention must not create trades or resting updates")
	}
	if buy.Status != domain.OrderStatusCancelled || buy.RejectReason != "self_trade_prevented" {
		t.Fatalf("expected cancel_newest self_trade_prevented, got status=%s reason=%s", buy.Status, buy.RejectReason)
	}
	if sell.Status != domain.OrderStatusOpen || sell.RemainingQuantity != 100 {
		t.Fatalf("resting order must remain unchanged")
	}
}

func testOrder(id string, side domain.Side, price int64, quantity int64, sequenceNumber int64) *domain.Order {
	now := time.Now().UTC()
	return &domain.Order{
		ID:                id,
		ClientOrderID:     "CLIENT-" + id,
		BrokerCode:        "MDLA",
		AccountID:         "INV-" + id,
		Symbol:            "MNDL",
		Side:              side,
		OrderType:         domain.OrderTypeLimit,
		Price:             price,
		OriginalQuantity:  quantity,
		RemainingQuantity: quantity,
		SequenceNumber:    sequenceNumber,
		CreatedAt:         now,
		UpdatedAt:         now,
	}
}
