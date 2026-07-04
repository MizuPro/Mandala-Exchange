package population

import (
	"reflect"
	"testing"

	"github.com/Mandala-Exchange/bot-v2/internal/config"
)

func TestGenerateIsDeterministicAndMatchesComposition(t *testing.T) {
	cfg := config.PopulationConfig{
		Enabled: true,
		Size:    20,
		Seed:    42,
		Composition: map[string]int{
			"noise_trader":    8,
			"momentum_trader": 7,
			"contrarian":      5,
		},
	}
	first, err := Generate(cfg)
	if err != nil {
		t.Fatal(err)
	}
	second, err := Generate(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(first, second) {
		t.Fatal("same seed must produce identical population")
	}
	if len(first) != 20 {
		t.Fatalf("expected 20 bots, got %d", len(first))
	}
	counts := map[string]int{}
	for _, bot := range first {
		counts[bot.Strategy]++
	}
	for strategy, expected := range cfg.Composition {
		if counts[strategy] != expected {
			t.Fatalf("strategy %s: got %d want %d", strategy, counts[strategy], expected)
		}
	}
}

func TestGenerateRejectsCompositionMismatch(t *testing.T) {
	_, err := Generate(config.PopulationConfig{
		Enabled:     true,
		Size:        50,
		Composition: map[string]int{"noise_trader": 49},
	})
	if err == nil {
		t.Fatal("expected composition mismatch error")
	}
}
