package main

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/Mandala-Exchange/BOT/internal/client/mats"
	"github.com/Mandala-Exchange/BOT/internal/scheduler"
)

func TestUpdateMarketPricePreservesActiveBEIRules(t *testing.T) {
	store := scheduler.NewSnapshotStore()
	store.Publish(scheduler.MarketSnapshot{
		Symbol: "BBCA", Price: 1000, LotSize: 100, RulesVersion: "v1",
	})
	updateMarketPrice(store, mats.Event{
		Symbol: "BBCA", OccurredAt: time.Now(),
		Payload: json.RawMessage(`{"price":"1015"}`),
	})
	snapshot, _ := store.Get("BBCA")
	if snapshot.Price != 1015 || snapshot.LotSize != 100 || snapshot.RulesVersion != "v1" {
		t.Fatalf("unexpected market snapshot: %+v", snapshot)
	}
}

func TestUpdateMarketPriceFailsClosedWithoutBEIRule(t *testing.T) {
	store := scheduler.NewSnapshotStore()
	updateMarketPrice(store, mats.Event{Symbol: "BBCA", Payload: json.RawMessage(`{"price":1015}`)})
	if _, ok := store.Get("BBCA"); ok {
		t.Fatal("MATS price must not create a snapshot without active BEI rules")
	}
}
