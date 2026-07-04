package mats

import (
	"encoding/json"
	"testing"
	"time"
)

func TestProcessEventAcceptsNumericMarketData(t *testing.T) {
	client := NewClient("ws://example.invalid", "", []string{"MNDL"})

	client.processEvent(Event{
		Type:    "depth_snapshot",
		Symbol:  "MNDL",
		Payload: json.RawMessage(`{"bids":[{"price":316,"quantity":1500}],"asks":[{"price":320,"quantity":800}]}`),
	})
	client.processEvent(Event{
		Type:    "last_price",
		Symbol:  "MNDL",
		Payload: json.RawMessage(`{"symbol":"MNDL","last":318}`),
	})
	client.processEvent(Event{
		Type:    "market_summary",
		Symbol:  "MNDL",
		Payload: json.RawMessage(`{"symbol":"MNDL","open":315,"high":325,"low":310,"close":318,"volume":12000,"value":3816000}`),
	})

	bid, ask := client.GetState().GetBestBidAsk("MNDL")
	if bid != "316" || ask != "320" {
		t.Fatalf("unexpected best bid/ask: %q/%q", bid, ask)
	}
	if got := client.GetState().GetLastPrice("MNDL"); got != "318" {
		t.Fatalf("unexpected last price: %q", got)
	}
	summary, ok := client.GetState().GetSummary("MNDL")
	if !ok || summary.Close != "318" || summary.Volume != "12000" {
		t.Fatalf("unexpected market summary: %#v, found=%v", summary, ok)
	}
}

func TestProcessEventHandlesSessionTimerAndBestBidAsk(t *testing.T) {
	client := NewClient("ws://example.invalid", "", []string{"MNDL"})

	client.processEvent(Event{
		Type:    "session_timer",
		Payload: json.RawMessage(`{"status":"continuous","time_remaining_seconds":120}`),
	})
	client.processEvent(Event{
		Type:    "best_bid_ask",
		Symbol:  "MNDL",
		Payload: json.RawMessage(`{"symbol":"MNDL","best_bid":{"price":317,"quantity":500,"orders":2},"best_ask":{"price":319,"quantity":400,"orders":1}}`),
	})

	if got := client.GetState().GetSessionSegment(); got != "continuous" {
		t.Fatalf("unexpected session segment: %q", got)
	}
	bid, ask := client.GetState().GetBestBidAsk("MNDL")
	if bid != "317" || ask != "319" {
		t.Fatalf("unexpected best bid/ask: %q/%q", bid, ask)
	}
}

func TestMarketSignalAggregatesReturnVolumeDepthAndImbalance(t *testing.T) {
	client := NewClient("ws://example.invalid", "", []string{"MNDL"})
	baseTime := time.Now()

	client.processEvent(Event{
		Type:       "depth_snapshot",
		Symbol:     "MNDL",
		OccurredAt: baseTime,
		Payload:    json.RawMessage(`{"bids":[{"price":320,"quantity":1500}],"asks":[{"price":322,"quantity":500}]}`),
	})
	client.processEvent(Event{
		Type:       "market_summary",
		Symbol:     "MNDL",
		OccurredAt: baseTime,
		Payload:    json.RawMessage(`{"symbol":"MNDL","last":320,"volume":1000,"frequency":10}`),
	})
	client.processEvent(Event{
		Type:       "market_summary",
		Symbol:     "MNDL",
		OccurredAt: baseTime.Add(time.Second),
		Payload:    json.RawMessage(`{"symbol":"MNDL","last":324,"volume":1600,"frequency":14}`),
	})

	signal, ok := client.GetState().GetSignal("MNDL")
	if !ok {
		t.Fatal("market signal was not created")
	}
	if signal.PreviousPrice != 320 || signal.LastPrice != 324 {
		t.Fatalf("unexpected price signal: %#v", signal)
	}
	if signal.VolumeDelta != 600 || signal.TradeCountDelta != 4 {
		t.Fatalf("unexpected deltas: %#v", signal)
	}
	if signal.Spread != 2 || signal.BidDepth != 1500 || signal.AskDepth != 500 {
		t.Fatalf("unexpected depth signal: %#v", signal)
	}
	if signal.OrderBookImbalance != 0.5 {
		t.Fatalf("unexpected imbalance: %f", signal.OrderBookImbalance)
	}
	if signal.ShortReturn <= 0 {
		t.Fatalf("expected positive short return, got %f", signal.ShortReturn)
	}
}

func TestUpdateSymbolsAndWarmingUp(t *testing.T) {
	client := NewClient("ws://example.invalid", "", []string{"MNDL", "NUSA"})

	// Verify initial symbols
	client.mu.Lock()
	if len(client.symbols) != 2 || client.symbols[0] != "MNDL" || client.symbols[1] != "NUSA" {
		client.mu.Unlock()
		t.Fatalf("unexpected initial symbols: %v", client.symbols)
	}
	client.mu.Unlock()

	// Update symbols with new ones: BARA and duplicate MNDL (lowercase)
	client.UpdateSymbols([]string{"mndl", "NUSA", "BARA", "bara"})

	// Check normalization: BARA, MNDL, NUSA
	client.mu.Lock()
	if len(client.symbols) != 3 || client.symbols[0] != "BARA" || client.symbols[1] != "MNDL" || client.symbols[2] != "NUSA" {
		client.mu.Unlock()
		t.Fatalf("unexpected normalized symbols: %v", client.symbols)
	}
	client.mu.Unlock()

	// BARA should be warming up (as it is new)
	if !client.GetState().IsWarmingUp("BARA") {
		t.Fatalf("expected BARA to be warming up")
	}
	// MNDL and NUSA should NOT be warming up (they were existing)
	if client.GetState().IsWarmingUp("MNDL") {
		t.Fatalf("expected MNDL to not be warming up")
	}

	// Send market data event for BARA
	client.processEvent(Event{
		Type:    "last_price",
		Symbol:  "BARA",
		Payload: json.RawMessage(`{"symbol":"BARA","last":150}`),
	})

	// BARA should no longer be warming up
	if client.GetState().IsWarmingUp("BARA") {
		t.Fatalf("expected BARA to be warmed up after market data event")
	}
}
