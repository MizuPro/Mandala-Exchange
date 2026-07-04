package strategy

import (
	"context"

	"github.com/Mandala-Exchange/bot-v2/internal/client/bei"
	"github.com/Mandala-Exchange/bot-v2/internal/client/mats"
	"github.com/Mandala-Exchange/bot-v2/internal/queue"
	"github.com/Mandala-Exchange/bot-v2/internal/registry"
)

// Strategy adalah interface yang harus diimplementasi oleh setiap jenis bot strategy.
// Decide dipanggil oleh Runner pada setiap tick sesi aktif untuk setiap bot.
// Kembalikan slice kosong jika bot memutuskan untuk tidak action (hold/skip).
type Strategy interface {
	Decide(
		ctx context.Context,
		bot *registry.BotInstance,
		beiSnap bei.Snapshot,
		matsState *mats.MarketState,
		segment string,
	) []queue.OrderDecision
}

// StrategyRegistry adalah kumpulan strategy yang di-instantiate berdasarkan nama.
type StrategyRegistry struct {
	strategies map[string]Strategy
}

// NewStrategyRegistry membuat strategy registry baru.
func NewStrategyRegistry() *StrategyRegistry {
	return &StrategyRegistry{
		strategies: make(map[string]Strategy),
	}
}

// Register mendaftarkan sebuah strategy dengan nama tertentu.
func (r *StrategyRegistry) Register(name string, s Strategy) {
	r.strategies[name] = s
}

// Get mengembalikan strategy berdasarkan nama.
// Jika tidak ditemukan, mengembalikan NoopStrategy agar bot tidak crash.
func (r *StrategyRegistry) Get(name string) Strategy {
	if s, ok := r.strategies[name]; ok {
		return s
	}
	return &NoopStrategy{}
}

// NoopStrategy adalah strategy fallback yang tidak melakukan apa-apa.
// Dipakai jika nama strategy tidak dikenali — mencegah crash jika ada bot
// dengan strategy yang belum diimplementasikan.
type NoopStrategy struct{}

func (n *NoopStrategy) Decide(
	_ context.Context,
	_ *registry.BotInstance,
	_ bei.Snapshot,
	_ *mats.MarketState,
	_ string,
) []queue.OrderDecision {
	return nil
}
