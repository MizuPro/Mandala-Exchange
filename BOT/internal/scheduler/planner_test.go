package scheduler

import (
	"testing"
	"time"

	"github.com/Mandala-Exchange/bot-v2/internal/config"
	"github.com/Mandala-Exchange/bot-v2/internal/registry"
)

func TestPlannerStaggersTwentyBotsAndReturnsOnlyDueBots(t *testing.T) {
	intervals := map[string]config.StrategyIntervalConfig{
		"noise_trader": {MinSeconds: 30, MaxSeconds: 90},
	}
	planner := NewPlanner(42, intervals)
	bots := make([]*registry.BotInstance, 0, 20)
	for index := 0; index < 20; index++ {
		bots = append(bots, registry.NewBotInstance(
			"noise-test", "account-"+time.Unix(int64(index), 0).Format("150405"), "noise_trader",
		))
	}
	now := time.Date(2026, 7, 4, 13, 0, 0, 0, time.UTC)
	planner.Reset(bots, now)

	unique := map[time.Time]struct{}{}
	for _, bot := range bots {
		next, ok := planner.NextEvaluation(bot.AccountID)
		if !ok {
			t.Fatalf("missing schedule for %s", bot.AccountID)
		}
		if next.Before(now.Add(30*time.Second)) || next.After(now.Add(90*time.Second)) {
			t.Fatalf("schedule out of range: %s", next)
		}
		unique[next] = struct{}{}
	}
	if len(unique) < 2 {
		t.Fatal("all bots were scheduled at the same time")
	}
	if due := planner.Due(bots, now.Add(29*time.Second)); len(due) != 0 {
		t.Fatalf("expected no due bots, got %d", len(due))
	}
	if due := planner.Due(bots, now.Add(91*time.Second)); len(due) != 20 {
		t.Fatalf("expected all 20 bots due, got %d", len(due))
	}
}

func TestPlannerIsDeterministic(t *testing.T) {
	intervals := map[string]config.StrategyIntervalConfig{
		"noise_trader": {MinSeconds: 1, MaxSeconds: 10},
	}
	now := time.Unix(0, 0)
	bots := []*registry.BotInstance{registry.NewBotInstance("bot", "account", "noise_trader")}
	first := NewPlanner(7, intervals)
	second := NewPlanner(7, intervals)
	first.Reset(bots, now)
	second.Reset(bots, now)
	firstNext, _ := first.NextEvaluation("account")
	secondNext, _ := second.NextEvaluation("account")
	if !firstNext.Equal(secondNext) {
		t.Fatalf("same seed produced different schedules: %s vs %s", firstNext, secondNext)
	}
}
