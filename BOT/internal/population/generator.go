package population

import (
	"fmt"
	"math/rand"
	"sort"
	"strings"

	"github.com/Mandala-Exchange/bot-v2/internal/client/bei"
	"github.com/Mandala-Exchange/bot-v2/internal/config"
)

type cashRange struct {
	min  int64
	max  int64
	tier string
}

var strategyCashRanges = map[string]cashRange{
	"noise_trader":    {1_000_000, 25_000_000, "retail"},
	"momentum_trader": {5_000_000, 75_000_000, "retail"},
	"contrarian":      {10_000_000, 150_000_000, "retail"},
	"event_driven":    {10_000_000, 250_000_000, "retail"},
	"market_maker":    {250_000_000, 2_000_000_000, "institutional"},
	"value_investor":  {100_000_000, 1_000_000_000, "institutional"},
	"index_tracker":   {250_000_000, 3_000_000_000, "institutional"},
	"bandar":          {1_000_000_000, 10_000_000_000, "institutional"},
}

func Generate(cfg config.PopulationConfig, activeSecurities []bei.Security) ([]config.BotConfig, error) {
	if !cfg.Enabled {
		return nil, nil
	}
	if cfg.Size <= 0 {
		return nil, fmt.Errorf("population size must be positive")
	}
	total := 0
	for strategy, count := range cfg.Composition {
		if count < 0 {
			return nil, fmt.Errorf("population composition for %s cannot be negative", strategy)
		}
		if _, ok := strategyCashRanges[strategy]; !ok {
			return nil, fmt.Errorf("unsupported population strategy %q", strategy)
		}
		total += count
	}
	if total != cfg.Size {
		return nil, fmt.Errorf("population composition totals %d, expected %d", total, cfg.Size)
	}

	seed := cfg.Seed
	if seed == 0 {
		seed = 20260704
	}
	rng := rand.New(rand.NewSource(seed))
	strategies := make([]string, 0, len(cfg.Composition))
	for strategy := range cfg.Composition {
		strategies = append(strategies, strategy)
	}
	sort.Strings(strategies)

	var listedSecurities []bei.Security
	for _, sec := range activeSecurities {
		if sec.Status == "listed" {
			listedSecurities = append(listedSecurities, sec)
		}
	}

	bots := make([]config.BotConfig, 0, cfg.Size)
	for _, strategy := range strategies {
		cash := strategyCashRanges[strategy]
		prefix := strategyPrefix(strategy)
		for index := 1; index <= cfg.Composition[strategy]; index++ {
			initialCash := cash.min
			if cash.max > cash.min {
				initialCash += rng.Int63n(cash.max - cash.min + 1)
			}
			id := fmt.Sprintf("%s-%04d", prefix, index)
			bots = append(bots, config.BotConfig{
				ExternalBotID:    id,
				Email:            id + "@bot.internal",
				Strategy:         strategy,
				Tier:             cash.tier,
				RiskProfile:      riskProfile(strategy),
				InitialCash:      initialCash,
				InitialPositions: generatedPositions(rng, strategy, listedSecurities),
			})
		}
	}
	return bots, nil
}

func generatedPositions(rng *rand.Rand, strategy string, securities []bei.Security) []config.GenesisPosition {
	minLots, maxLots := int64(5), int64(10)
	if strategy == "market_maker" || strategy == "index_tracker" || strategy == "bandar" {
		minLots, maxLots = 20, 50
	}
	positions := make([]config.GenesisPosition, 0, len(securities))
	for _, sec := range securities {
		lots := minLots + rng.Int63n(maxLots-minLots+1)
		refPrice := sec.ReferencePrice
		if refPrice <= 0 {
			refPrice = 100 // fallback safe price
		}
		positions = append(positions, config.GenesisPosition{
			Symbol:       sec.Symbol,
			Quantity:     lots * 100,
			AveragePrice: refPrice,
		})
	}
	return positions
}

func riskProfile(strategy string) string {
	switch strategy {
	case "market_maker", "index_tracker":
		return "controlled"
	case "bandar":
		return "high"
	case "value_investor", "contrarian":
		return "moderate"
	default:
		return "retail"
	}
}

func strategyPrefix(strategy string) string {
	switch strategy {
	case "noise_trader":
		return "noise"
	case "momentum_trader":
		return "momentum"
	case "market_maker":
		return "mm"
	case "value_investor":
		return "value"
	case "index_tracker":
		return "index"
	default:
		return strings.ReplaceAll(strategy, "_", "-")
	}
}
