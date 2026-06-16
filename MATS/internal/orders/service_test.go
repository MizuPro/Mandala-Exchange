package orders

import (
	"context"
	"testing"

	"mandala-exchange/mats/internal/bei"
	"mandala-exchange/mats/internal/domain"
	"mandala-exchange/mats/internal/marketdata"
	"mandala-exchange/mats/internal/matching"
	"mandala-exchange/mats/internal/persistence"
	"mandala-exchange/mats/internal/rules"
	"mandala-exchange/mats/internal/sequence"
)

func TestServicePlaceOrderMatchesAndPersistsStatus(t *testing.T) {
	ctx := context.Background()
	service, _ := newTestService()

	buy, err := service.Place(ctx, PlaceRequest{
		ClientOrderID:  "BUY-1",
		BrokerCode:     "MDLA",
		AccountID:      "BUYER",
		Symbol:         "MNDL",
		Side:           domain.SideBuy,
		OrderType:      domain.OrderTypeLimit,
		Price:          100,
		Quantity:       100,
		IdempotencyKey: "buy-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if buy.Order.Status != domain.OrderStatusOpen {
		t.Fatalf("expected buy open, got %s", buy.Order.Status)
	}

	sell, err := service.Place(ctx, PlaceRequest{
		ClientOrderID:  "SELL-1",
		BrokerCode:     "MDLA",
		AccountID:      "SELLER",
		Symbol:         "MNDL",
		Side:           domain.SideSell,
		OrderType:      domain.OrderTypeLimit,
		Price:          100,
		Quantity:       100,
		IdempotencyKey: "sell-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if sell.Order.Status != domain.OrderStatusFilled {
		t.Fatalf("expected sell filled, got %s", sell.Order.Status)
	}
	if len(sell.Trades) != 1 {
		t.Fatalf("expected 1 trade, got %d", len(sell.Trades))
	}
	updatedBuy, err := service.Get(ctx, buy.Order.ID)
	if err != nil {
		t.Fatal(err)
	}
	if updatedBuy.Status != domain.OrderStatusFilled {
		t.Fatalf("expected persisted buy filled, got %s", updatedBuy.Status)
	}
}

func TestServiceRejectsInvalidTick(t *testing.T) {
	ctx := context.Background()
	service, cache := newTestService()
	cache.Replace(testSecurities(), []bei.RuleProfile{testRuleProfile(5)}, testSession())

	response, err := service.Place(ctx, PlaceRequest{
		ClientOrderID:  "BUY-1",
		BrokerCode:     "MDLA",
		AccountID:      "BUYER",
		Symbol:         "MNDL",
		Side:           domain.SideBuy,
		OrderType:      domain.OrderTypeLimit,
		Price:          103,
		Quantity:       100,
		IdempotencyKey: "bad-tick",
	})
	if err != nil {
		t.Fatal(err)
	}
	if response.Order.Status != domain.OrderStatusRejected {
		t.Fatalf("expected rejected order, got %s", response.Order.Status)
	}
	if response.Order.RejectReason != "price_not_valid_tick" {
		t.Fatalf("unexpected reject reason %q", response.Order.RejectReason)
	}
}

func TestServiceExpiresOpenOrders(t *testing.T) {
	ctx := context.Background()
	service, _ := newTestService()

	placed, err := service.Place(ctx, PlaceRequest{
		ClientOrderID:  "BUY-EXPIRE",
		BrokerCode:     "MDLA",
		AccountID:      "BUYER",
		Symbol:         "MNDL",
		Side:           domain.SideBuy,
		OrderType:      domain.OrderTypeLimit,
		Price:          90,
		Quantity:       100,
		IdempotencyKey: "buy-expire",
	})
	if err != nil {
		t.Fatal(err)
	}
	if placed.Order.Status != domain.OrderStatusOpen {
		t.Fatalf("expected open order, got %s", placed.Order.Status)
	}

	expired, err := service.ExpireOpenOrders(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(expired) != 1 {
		t.Fatalf("expected 1 expired order, got %d", len(expired))
	}
	if expired[0].Status != domain.OrderStatusExpired {
		t.Fatalf("expected expired status, got %s", expired[0].Status)
	}
}

func TestServiceCollectsAuctionOrdersThenUncrosses(t *testing.T) {
	ctx := context.Background()
	service, cache := newTestService()
	cache.SetSessionStatus(domain.SessionOpeningAuction)

	buy, err := service.Place(ctx, PlaceRequest{
		ClientOrderID:  "BUY-AUCTION",
		BrokerCode:     "MDLA",
		AccountID:      "BUYER",
		Symbol:         "MNDL",
		Side:           domain.SideBuy,
		OrderType:      domain.OrderTypeLimit,
		Price:          105,
		Quantity:       100,
		IdempotencyKey: "buy-auction",
	})
	if err != nil {
		t.Fatal(err)
	}
	sell, err := service.Place(ctx, PlaceRequest{
		ClientOrderID:  "SELL-AUCTION",
		BrokerCode:     "MDLA",
		AccountID:      "SELLER",
		Symbol:         "MNDL",
		Side:           domain.SideSell,
		OrderType:      domain.OrderTypeLimit,
		Price:          95,
		Quantity:       100,
		IdempotencyKey: "sell-auction",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(buy.Trades) != 0 || len(sell.Trades) != 0 {
		t.Fatalf("expected auction orders to be collected without immediate trades")
	}
	indicative := service.Indicative("MNDL")
	if indicative.Volume != 100 {
		t.Fatalf("expected indicative volume 100, got %d", indicative.Volume)
	}
	_, trades, updated, err := service.UncrossAuction(ctx, "MNDL")
	if err != nil {
		t.Fatal(err)
	}
	if len(trades) != 1 {
		t.Fatalf("expected one trade after uncross, got %d", len(trades))
	}
	if len(updated) != 2 {
		t.Fatalf("expected two updated orders, got %d", len(updated))
	}
}

func newTestService() (*Service, *rules.Cache) {
	seq := sequence.NewAtomic(0)
	store := persistence.NewMemoryStore()
	cache := rules.NewCache(nil)
	cache.Replace(testSecurities(), []bei.RuleProfile{testRuleProfile(1)}, testSession())
	engine := matching.NewEngine(seq, "SESSION-1", marketdata.NewSummaryStore())
	service := NewService(engine, store, seq, cache, BrokerValidatorFunc(func(context.Context, string) (bool, string, error) {
		return true, "", nil
	}))
	return service, cache
}

func testSecurities() []bei.Security {
	return []bei.Security{{
		Symbol:            "MNDL",
		Board:             "main",
		Status:            "listed",
		MarketMechanism:   "regular",
		ReferencePrice:    domain.NumericInt(100),
		SharesOutstanding: domain.NumericInt(1_000_000),
	}}
}

func testRuleProfile(tickSize int64) bei.RuleProfile {
	return bei.RuleProfile{
		ID:            "rule-main",
		Board:         "main",
		MarketSegment: "regular",
		IsDefault:     true,
		LotSizeRules: []bei.LotSizeRule{{
			LotSize: 100,
		}},
		TickSizeRules: []bei.TickSizeRule{{
			MinPrice: domain.NumericInt(1),
			TickSize: domain.NumericInt(tickSize),
		}},
		PriceBandRules: []bei.PriceBandRule{{
			MinReferencePrice: domain.NumericInt(1),
			ARAPercent:        domain.NumericFloat(10),
			ARBPercent:        domain.NumericFloat(10),
			MinPrice:          domain.NumericInt(1),
		}},
		AutoRejectionRules: []bei.AutoRejectionRule{{
			MaxLotsPerOrder: 1000,
		}},
	}
}

func testSession() *bei.SessionTemplate {
	return &bei.SessionTemplate{
		ID:       "SESSION-1",
		Name:     "Regular",
		Status:   domain.SessionContinuous,
		IsActive: true,
	}
}
