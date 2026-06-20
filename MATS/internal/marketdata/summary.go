package marketdata

import (
	"sync"

	"mandala-exchange/mats/internal/domain"
)

type SummaryStore struct {
	mu        sync.RWMutex
	summaries map[string]domain.MarketSummary
}

func NewSummaryStore() *SummaryStore {
	return &SummaryStore{summaries: make(map[string]domain.MarketSummary)}
}

func (s *SummaryStore) ApplyTrade(trade domain.Trade) domain.MarketSummary {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.applyTradeLocked(trade)
}

func (s *SummaryStore) Recover(trades []domain.Trade) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.summaries = make(map[string]domain.MarketSummary)
	for _, trade := range trades {
		s.applyTradeLocked(trade)
	}
}

func (s *SummaryStore) applyTradeLocked(trade domain.Trade) domain.MarketSummary {
	summary := s.summaries[trade.Symbol]
	if summary.Symbol == "" {
		summary.Symbol = trade.Symbol
		summary.Open = trade.Price
		summary.High = trade.Price
		summary.Low = trade.Price
	}
	if trade.Price > summary.High {
		summary.High = trade.Price
	}
	if trade.Price < summary.Low || summary.Low == 0 {
		summary.Low = trade.Price
	}
	summary.Last = trade.Price
	summary.Close = trade.Price
	summary.Volume += trade.Quantity
	summary.Value += trade.Price * trade.Quantity
	summary.Frequency++
	s.summaries[trade.Symbol] = summary
	return summary
}

func (s *SummaryStore) Get(symbol string) (domain.MarketSummary, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	summary, ok := s.summaries[symbol]
	return summary, ok
}
