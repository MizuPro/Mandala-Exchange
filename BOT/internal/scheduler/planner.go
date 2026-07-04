package scheduler

import (
	"math/rand"
	"sync"
	"time"

	"github.com/Mandala-Exchange/bot-v2/internal/config"
	"github.com/Mandala-Exchange/bot-v2/internal/registry"
)

type Planner struct {
	mu        sync.Mutex
	rng       *rand.Rand
	intervals map[string]config.StrategyIntervalConfig
	next      map[string]time.Time
	last      map[string]time.Time
}

func NewPlanner(seed int64, intervals map[string]config.StrategyIntervalConfig) *Planner {
	return &Planner{
		rng:       rand.New(rand.NewSource(seed)),
		intervals: intervals,
		next:      make(map[string]time.Time),
		last:      make(map[string]time.Time),
	}
}

func (p *Planner) Reset(bots []*registry.BotInstance, now time.Time) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.next = make(map[string]time.Time, len(bots))
	p.last = make(map[string]time.Time, len(bots))
	for _, bot := range bots {
		p.next[bot.AccountID] = now.Add(p.randomInterval(bot.Strategy))
	}
}

func (p *Planner) Due(bots []*registry.BotInstance, now time.Time) []*registry.BotInstance {
	p.mu.Lock()
	defer p.mu.Unlock()

	due := make([]*registry.BotInstance, 0)
	active := make(map[string]struct{}, len(bots))
	for _, bot := range bots {
		active[bot.AccountID] = struct{}{}
		next, ok := p.next[bot.AccountID]
		if !ok {
			p.next[bot.AccountID] = now.Add(p.randomInterval(bot.Strategy))
			continue
		}
		if now.Before(next) {
			continue
		}
		due = append(due, bot)
		p.last[bot.AccountID] = now
		p.next[bot.AccountID] = now.Add(p.randomInterval(bot.Strategy))
	}
	for accountID := range p.next {
		if _, ok := active[accountID]; !ok {
			delete(p.next, accountID)
			delete(p.last, accountID)
		}
	}
	return due
}

func (p *Planner) LastEvaluation(accountID string) (time.Time, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	last, ok := p.last[accountID]
	return last, ok
}

func (p *Planner) NextEvaluation(accountID string) (time.Time, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	next, ok := p.next[accountID]
	return next, ok
}

func (p *Planner) randomInterval(strategy string) time.Duration {
	interval, ok := p.intervals[strategy]
	if !ok {
		interval = config.StrategyIntervalConfig{MinSeconds: 30, MaxSeconds: 90}
	}
	minSeconds := interval.MinSeconds
	maxSeconds := interval.MaxSeconds
	if minSeconds <= 0 {
		minSeconds = 30
	}
	if maxSeconds < minSeconds {
		maxSeconds = minSeconds
	}
	seconds := minSeconds
	if maxSeconds > minSeconds {
		seconds += p.rng.Intn(maxSeconds - minSeconds + 1)
	}
	return time.Duration(seconds) * time.Second
}
