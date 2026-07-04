package scheduler_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/Mandala-Exchange/bot-v2/internal/client/bei"
	"github.com/Mandala-Exchange/bot-v2/internal/client/mats"
	"github.com/Mandala-Exchange/bot-v2/internal/config"
	"github.com/Mandala-Exchange/bot-v2/internal/queue"
	"github.com/Mandala-Exchange/bot-v2/internal/registry"
	"github.com/Mandala-Exchange/bot-v2/internal/runner"
	"github.com/Mandala-Exchange/bot-v2/internal/scheduler"
	"github.com/Mandala-Exchange/bot-v2/internal/strategy"
)

type deterministicStrategy struct{}

func (deterministicStrategy) Decide(
	_ context.Context,
	bot *registry.BotInstance,
	_ bei.Snapshot,
	_ *mats.MarketState,
	_ string,
) []queue.OrderDecision {
	return []queue.OrderDecision{{
		AccountID:     bot.AccountID,
		ClientOrderID: "bot:" + bot.ExternalBotID + ":test:1",
		Symbol:        "MNDL",
		Side:          "buy",
		OrderType:     "limit",
		Price:         320,
		Quantity:      100,
	}}
}

func TestTwentyBotsFlowFromPlannerToRunnerQueue(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/bot/session-state" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"session-4a","status":"continuous"}`))
	}))
	defer server.Close()

	ctx := context.Background()
	beiClient := bei.NewClient(server.URL, "test")
	if _, err := beiClient.PollSessionState(ctx); err != nil {
		t.Fatal(err)
	}
	matsClient := mats.NewClient("ws://example.invalid", "", []string{"MNDL"})
	reg := registry.NewRegistry()
	bots := make([]*registry.BotInstance, 0, 20)
	for index := 0; index < 20; index++ {
		accountID := "account-" + time.Unix(int64(index), 0).Format("150405")
		bots = append(bots, reg.Register("noise-test", accountID, "noise_trader"))
	}

	orderQueue := queue.NewOrderQueue(25, time.Minute)
	strategies := strategy.NewStrategyRegistry()
	strategies.Register("noise_trader", deterministicStrategy{})
	botRunner := runner.New(reg, beiClient, matsClient, orderQueue, strategies)
	planner := scheduler.NewPlanner(42, map[string]config.StrategyIntervalConfig{
		"noise_trader": {MinSeconds: 1, MaxSeconds: 20},
	})
	now := time.Unix(0, 0)
	planner.Reset(bots, now)
	due := planner.Due(bots, now.Add(21*time.Second))
	if len(due) != 20 {
		t.Fatalf("expected 20 due bots, got %d", len(due))
	}

	botRunner.RunBotDecisionsFor(ctx, "continuous", due)
	for index := 0; index < 20; index++ {
		if _, err := orderQueue.Dequeue(ctx); err != nil {
			t.Fatalf("order %d was not queued: %v", index, err)
		}
	}
}
