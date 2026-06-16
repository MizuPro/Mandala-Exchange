package matching

import (
	"context"
	"testing"

	"mandala-exchange/mats/internal/domain"
	"mandala-exchange/mats/internal/marketdata"
	"mandala-exchange/mats/internal/sequence"
)

func TestAuctionIndicativeChoosesMaxVolumeMinImbalance(t *testing.T) {
	engine := NewEngine(sequence.NewAtomic(300), "SESSION-1", marketdata.NewSummaryStore())
	engine.PlaceAuction(testOrder("B1", domain.SideBuy, 105, 200, 1))
	engine.PlaceAuction(testOrder("B2", domain.SideBuy, 100, 100, 2))
	engine.PlaceAuction(testOrder("S1", domain.SideSell, 95, 100, 3))
	engine.PlaceAuction(testOrder("S2", domain.SideSell, 100, 200, 4))

	indicative := engine.Indicative("MNDL", 100)
	if indicative.Price != 100 {
		t.Fatalf("expected IEP 100, got %d", indicative.Price)
	}
	if indicative.Volume != 300 {
		t.Fatalf("expected IEV 300, got %d", indicative.Volume)
	}
	if indicative.Imbalance != 0 {
		t.Fatalf("expected imbalance 0, got %d", indicative.Imbalance)
	}
}

func TestAuctionUncrossGeneratesTradesAtIEP(t *testing.T) {
	ctx := context.Background()
	engine := NewEngine(sequence.NewAtomic(400), "SESSION-1", marketdata.NewSummaryStore())
	engine.PlaceAuction(testOrder("B1", domain.SideBuy, 105, 100, 1))
	engine.PlaceAuction(testOrder("S1", domain.SideSell, 95, 100, 2))

	indicative, trades, updated, err := engine.UncrossAuction(ctx, "MNDL", 100)
	if err != nil {
		t.Fatal(err)
	}
	if indicative.Price != 95 {
		t.Fatalf("expected IEP closest tie at 95, got %d", indicative.Price)
	}
	if len(trades) != 1 {
		t.Fatalf("expected 1 auction trade, got %d", len(trades))
	}
	if trades[0].Price != indicative.Price {
		t.Fatalf("expected auction trade price %d, got %d", indicative.Price, trades[0].Price)
	}
	if len(updated) != 2 {
		t.Fatalf("expected two updated orders, got %d", len(updated))
	}
}
