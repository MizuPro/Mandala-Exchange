package config

import (
	"fmt"
	"os"
	"time"

	"gopkg.in/yaml.v3"
)

type Config struct {
	BEI struct {
		BaseURL      string        `yaml:"base_url"`
		ServiceToken string        `yaml:"service_token"`
		PollInterval time.Duration `yaml:"poll_interval"`
	} `yaml:"bei"`
	MATS struct {
		WSURL        string   `yaml:"ws_url"`
		ServiceToken string   `yaml:"service_token"`
		Symbols      []string `yaml:"symbols"`
	} `yaml:"mats"`
	Sekuritas struct {
		BaseURL      string `yaml:"base_url"`
		ServiceToken string `yaml:"service_token"`
	} `yaml:"sekuritas"`
	Queue struct {
		BufferSize int           `yaml:"buffer_size"`
		TTL        time.Duration `yaml:"ttl"`
	} `yaml:"queue"`
	Executor struct {
		OrdersPerMinute int `yaml:"orders_per_minute"`
	} `yaml:"executor"`
	Scheduler SchedulerConfig `yaml:"scheduler"`
	Admin     struct {
		Port int `yaml:"port"`
	} `yaml:"admin"`
	Strategy   StrategyConfig   `yaml:"strategy"`
	Population PopulationConfig `yaml:"population"`
	Bots       []BotConfig      `yaml:"bots"`
}

type BotConfig struct {
	ExternalBotID    string            `yaml:"external_bot_id"`
	Email            string            `yaml:"email"`
	Strategy         string            `yaml:"strategy"`
	Tier             string            `yaml:"tier"`
	RiskProfile      string            `yaml:"risk_profile"`
	InitialCash      int64             `yaml:"initial_cash"`
	InitialPositions []GenesisPosition `yaml:"initial_positions"`
}

type GenesisPosition struct {
	Symbol       string `yaml:"symbol"`
	Quantity     int64  `yaml:"quantity_shares"`
	AveragePrice int64  `yaml:"average_price_idr"`
}

type PopulationConfig struct {
	Enabled     bool           `yaml:"enabled"`
	Size        int            `yaml:"size"`
	Seed        int64          `yaml:"seed"`
	Composition map[string]int `yaml:"composition"`
}

type SchedulerConfig struct {
	ScanInterval time.Duration                     `yaml:"scan_interval"`
	Seed         int64                             `yaml:"seed"`
	Intervals    map[string]StrategyIntervalConfig `yaml:"intervals"`
}

type StrategyIntervalConfig struct {
	MinSeconds int `yaml:"min_seconds"`
	MaxSeconds int `yaml:"max_seconds"`
}

// StrategyConfig menampung konfigurasi semua jenis strategy.
type StrategyConfig struct {
	NoiseTrader    NoiseTraderConfig    `yaml:"noise_trader"`
	MomentumTrader MomentumTraderConfig `yaml:"momentum_trader"`
	Contrarian     ContrarianConfig     `yaml:"contrarian"`
	EventDriven    EventDrivenConfig    `yaml:"event_driven"`
	MarketMaker    MarketMakerConfig    `yaml:"market_maker"`
	ValueInvestor  ValueInvestorConfig  `yaml:"value_investor"`
	IndexTracker   IndexTrackerConfig   `yaml:"index_tracker"`
	Bandar         BandarConfig         `yaml:"bandar"`
}

// NoiseTraderConfig adalah parameter konfigurasi untuk Noise Trader strategy.
type NoiseTraderConfig struct {
	// InactiveRate adalah probabilitas (0.0-1.0) bot skip satu sesi tanpa order.
	InactiveRate float64 `yaml:"inactive_rate"`
	// MaxOrdersPerSession adalah maksimal order yang boleh dikirim bot per sesi.
	MaxOrdersPerSession int `yaml:"max_orders_per_session"`
	// MaxLotsPerOrder adalah batas lot per order (sebelum auto-rejection check).
	MaxLotsPerOrder int64 `yaml:"max_lots_per_order"`
	// PriceNoisePct adalah besar noise harga dalam desimal (0.02 = +/- 2%).
	PriceNoisePct float64 `yaml:"price_noise_pct"`
	// OpeningAuctionRate adalah probabilitas (0.0-1.0) bot ikut opening auction.
	OpeningAuctionRate float64 `yaml:"opening_auction_rate"`
	// ClosingAuctionRate adalah probabilitas (0.0-1.0) bot ikut closing auction.
	ClosingAuctionRate float64 `yaml:"closing_auction_rate"`
	// ContinuousTickIntervalMin adalah interval minimum (detik) antar evaluasi di continuous.
	ContinuousTickIntervalMin int `yaml:"continuous_tick_interval_min"`
	// ContinuousTickIntervalMax adalah interval maksimum (detik) antar evaluasi di continuous.
	ContinuousTickIntervalMax int `yaml:"continuous_tick_interval_max"`
}

// MomentumTraderConfig adalah parameter konfigurasi untuk Momentum Trader strategy.
type MomentumTraderConfig struct {
	InactiveRate             float64 `yaml:"inactive_rate"`
	MaxOrdersPerSession      int     `yaml:"max_orders_per_session"`
	MaxLotsPerOrder          int64   `yaml:"max_lots_per_order"`
	SpreadThresholdPct       float64 `yaml:"spread_threshold_pct"`
	ImbalanceThreshold       float64 `yaml:"imbalance_threshold"`
	ReturnThreshold          float64 `yaml:"return_threshold"`
	FairValueBrakeMultiplier float64 `yaml:"fair_value_brake_multiplier"`
	OpeningAuctionRate       float64 `yaml:"opening_auction_rate"`
	ClosingAuctionRate       float64 `yaml:"closing_auction_rate"`
	ContinuousTickIntervalMin int    `yaml:"continuous_tick_interval_min"`
	ContinuousTickIntervalMax int    `yaml:"continuous_tick_interval_max"`
}

// ContrarianConfig adalah parameter konfigurasi untuk Contrarian Trader strategy.
type ContrarianConfig struct {
	InactiveRate               float64 `yaml:"inactive_rate"`
	MaxOrdersPerSession        int     `yaml:"max_orders_per_session"`
	MaxLotsPerOrder            int64   `yaml:"max_lots_per_order"`
	DiscountThreshold          float64 `yaml:"discount_threshold"`
	PremiumThreshold           float64 `yaml:"premium_threshold"`
	ReferenceDeviationThreshold float64 `yaml:"reference_deviation_threshold"`
	OpeningAuctionRate         float64 `yaml:"opening_auction_rate"`
	ClosingAuctionRate         float64 `yaml:"closing_auction_rate"`
	ContinuousTickIntervalMin   int    `yaml:"continuous_tick_interval_min"`
	ContinuousTickIntervalMax   int    `yaml:"continuous_tick_interval_max"`
}

// EventDrivenConfig adalah parameter konfigurasi untuk Event-Driven strategy.
type EventDrivenConfig struct {
	InactiveRate             float64 `yaml:"inactive_rate"`
	MaxOrdersPerSession      int     `yaml:"max_orders_per_session"`
	MaxLotsPerOrder          int64   `yaml:"max_lots_per_order"`
	OpeningAuctionRate       float64 `yaml:"opening_auction_rate"`
	ClosingAuctionRate       float64 `yaml:"closing_auction_rate"`
	ContinuousTickIntervalMin int    `yaml:"continuous_tick_interval_min"`
	ContinuousTickIntervalMax int    `yaml:"continuous_tick_interval_max"`
}

// MarketMakerConfig adalah parameter konfigurasi untuk Market Maker strategy.
type MarketMakerConfig struct {
	InactiveRate             float64 `yaml:"inactive_rate"`
	MaxOrdersPerSession      int     `yaml:"max_orders_per_session"`
	MaxLotsPerOrder          int64   `yaml:"max_lots_per_order"`
	BaseSpreadTicks          int     `yaml:"base_spread_ticks"`
	MaxInventoryShares       int64   `yaml:"max_inventory_shares"`
	OpeningAuctionRate       float64 `yaml:"opening_auction_rate"`
	ClosingAuctionRate       float64 `yaml:"closing_auction_rate"`
	ContinuousTickIntervalMin int    `yaml:"continuous_tick_interval_min"`
	ContinuousTickIntervalMax int    `yaml:"continuous_tick_interval_max"`
}

// ValueInvestorConfig adalah parameter konfigurasi untuk Value Investor strategy.
type ValueInvestorConfig struct {
	InactiveRate              float64 `yaml:"inactive_rate"`
	MaxOrdersPerSession       int     `yaml:"max_orders_per_session"`
	MaxLotsPerOrder           int64   `yaml:"max_lots_per_order"`
	DiscountThreshold         float64 `yaml:"discount_threshold"`
	PremiumThreshold          float64 `yaml:"premium_threshold"`
	OpeningAuctionRate        float64 `yaml:"opening_auction_rate"`
	ClosingAuctionRate        float64 `yaml:"closing_auction_rate"`
	ContinuousTickIntervalMin int     `yaml:"continuous_tick_interval_min"`
	ContinuousTickIntervalMax int     `yaml:"continuous_tick_interval_max"`
}

// IndexTrackerConfig adalah parameter konfigurasi untuk Index Tracker strategy.
type IndexTrackerConfig struct {
	InactiveRate              float64 `yaml:"inactive_rate"`
	MaxOrdersPerSession       int     `yaml:"max_orders_per_session"`
	MaxLotsPerOrder           int64   `yaml:"max_lots_per_order"`
	OpeningAuctionRate        float64 `yaml:"opening_auction_rate"`
	ClosingAuctionRate        float64 `yaml:"closing_auction_rate"`
	ContinuousTickIntervalMin int     `yaml:"continuous_tick_interval_min"`
	ContinuousTickIntervalMax int     `yaml:"continuous_tick_interval_max"`
}

// BandarConfig adalah parameter konfigurasi untuk Bandar strategy.
type BandarConfig struct {
	InactiveRate              float64 `yaml:"inactive_rate"`
	MaxOrdersPerSession       int     `yaml:"max_orders_per_session"`
	MaxLotsPerOrder           int64   `yaml:"max_lots_per_order"`
	FairValueBrakeMultiplier  float64 `yaml:"fair_value_brake_multiplier"`
	BrakeDiscount             float64 `yaml:"brake_discount"`
	OpeningAuctionRate        float64 `yaml:"opening_auction_rate"`
	ClosingAuctionRate        float64 `yaml:"closing_auction_rate"`
	ContinuousTickIntervalMin int     `yaml:"continuous_tick_interval_min"`
	ContinuousTickIntervalMax int     `yaml:"continuous_tick_interval_max"`
}

func LoadConfig(path string) (*Config, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("failed to open config file: %w", err)
	}
	defer file.Close()

	var cfg Config
	decoder := yaml.NewDecoder(file)
	if err := decoder.Decode(&cfg); err != nil {
		return nil, fmt.Errorf("failed to decode config file: %w", err)
	}

	// Environment variable overrides
	if token := os.Getenv("BEI_SERVICE_TOKEN"); token != "" {
		cfg.BEI.ServiceToken = token
	}
	if token := os.Getenv("SEKURITAS_SERVICE_TOKEN"); token != "" {
		cfg.Sekuritas.ServiceToken = token
	}
	if token := os.Getenv("MATS_SERVICE_TOKEN"); token != "" {
		cfg.MATS.ServiceToken = token
	}
	if url := os.Getenv("BEI_BASE_URL"); url != "" {
		cfg.BEI.BaseURL = url
	}
	if url := os.Getenv("SEKURITAS_BASE_URL"); url != "" {
		cfg.Sekuritas.BaseURL = url
	}
	if url := os.Getenv("MATS_WS_URL"); url != "" {
		cfg.MATS.WSURL = url
	}

	// Basic Validation
	if cfg.BEI.BaseURL == "" {
		return nil, fmt.Errorf("BEI BaseURL is required")
	}
	if cfg.BEI.ServiceToken == "" {
		return nil, fmt.Errorf("BEI ServiceToken is required")
	}
	if cfg.MATS.ServiceToken == "" {
		return nil, fmt.Errorf("MATS ServiceToken is required")
	}
	if cfg.Sekuritas.BaseURL == "" {
		return nil, fmt.Errorf("Sekuritas BaseURL is required")
	}
	if cfg.Sekuritas.ServiceToken == "" {
		return nil, fmt.Errorf("Sekuritas ServiceToken is required")
	}
	if cfg.Queue.BufferSize <= 0 {
		cfg.Queue.BufferSize = 500
	}
	if cfg.Queue.TTL <= 0 {
		cfg.Queue.TTL = 30 * time.Second
	}
	if cfg.Executor.OrdersPerMinute <= 0 {
		cfg.Executor.OrdersPerMinute = 60
	}
	if cfg.Scheduler.ScanInterval <= 0 {
		cfg.Scheduler.ScanInterval = time.Second
	}
	if cfg.Scheduler.Seed == 0 {
		cfg.Scheduler.Seed = time.Now().UnixNano()
	}
	if cfg.Scheduler.Intervals == nil {
		cfg.Scheduler.Intervals = make(map[string]StrategyIntervalConfig)
	}
	if cfg.Admin.Port <= 0 {
		cfg.Admin.Port = 4200
	}

	// Strategy defaults
	if cfg.Strategy.NoiseTrader.InactiveRate <= 0 {
		cfg.Strategy.NoiseTrader.InactiveRate = 0.15
	}
	if cfg.Strategy.NoiseTrader.MaxOrdersPerSession <= 0 {
		cfg.Strategy.NoiseTrader.MaxOrdersPerSession = 2
	}
	if cfg.Strategy.NoiseTrader.MaxLotsPerOrder <= 0 {
		cfg.Strategy.NoiseTrader.MaxLotsPerOrder = 5
	}
	if cfg.Strategy.NoiseTrader.PriceNoisePct <= 0 {
		cfg.Strategy.NoiseTrader.PriceNoisePct = 0.02
	}
	if cfg.Strategy.NoiseTrader.OpeningAuctionRate <= 0 {
		cfg.Strategy.NoiseTrader.OpeningAuctionRate = 0.15
	}
	if cfg.Strategy.NoiseTrader.ClosingAuctionRate <= 0 {
		cfg.Strategy.NoiseTrader.ClosingAuctionRate = 0.08
	}
	if cfg.Strategy.NoiseTrader.ContinuousTickIntervalMin <= 0 {
		cfg.Strategy.NoiseTrader.ContinuousTickIntervalMin = 30
	}
	if cfg.Strategy.NoiseTrader.ContinuousTickIntervalMax <= 0 {
		cfg.Strategy.NoiseTrader.ContinuousTickIntervalMax = 90
	}
	if _, ok := cfg.Scheduler.Intervals["noise_trader"]; !ok {
		cfg.Scheduler.Intervals["noise_trader"] = StrategyIntervalConfig{
			MinSeconds: cfg.Strategy.NoiseTrader.ContinuousTickIntervalMin,
			MaxSeconds: cfg.Strategy.NoiseTrader.ContinuousTickIntervalMax,
		}
	}

	// Momentum Trader defaults
	if cfg.Strategy.MomentumTrader.InactiveRate <= 0 {
		cfg.Strategy.MomentumTrader.InactiveRate = 0.10
	}
	if cfg.Strategy.MomentumTrader.MaxOrdersPerSession <= 0 {
		cfg.Strategy.MomentumTrader.MaxOrdersPerSession = 3
	}
	if cfg.Strategy.MomentumTrader.MaxLotsPerOrder <= 0 {
		cfg.Strategy.MomentumTrader.MaxLotsPerOrder = 10
	}
	if cfg.Strategy.MomentumTrader.SpreadThresholdPct <= 0 {
		cfg.Strategy.MomentumTrader.SpreadThresholdPct = 0.05
	}
	if cfg.Strategy.MomentumTrader.ImbalanceThreshold <= 0 {
		cfg.Strategy.MomentumTrader.ImbalanceThreshold = 0.10
	}
	if cfg.Strategy.MomentumTrader.ReturnThreshold <= 0 {
		cfg.Strategy.MomentumTrader.ReturnThreshold = 0.005
	}
	if cfg.Strategy.MomentumTrader.FairValueBrakeMultiplier <= 0 {
		cfg.Strategy.MomentumTrader.FairValueBrakeMultiplier = 1.5
	}
	if cfg.Strategy.MomentumTrader.OpeningAuctionRate <= 0 {
		cfg.Strategy.MomentumTrader.OpeningAuctionRate = 0.20
	}
	if cfg.Strategy.MomentumTrader.ClosingAuctionRate <= 0 {
		cfg.Strategy.MomentumTrader.ClosingAuctionRate = 0.10
	}
	if cfg.Strategy.MomentumTrader.ContinuousTickIntervalMin <= 0 {
		cfg.Strategy.MomentumTrader.ContinuousTickIntervalMin = 10
	}
	if cfg.Strategy.MomentumTrader.ContinuousTickIntervalMax <= 0 {
		cfg.Strategy.MomentumTrader.ContinuousTickIntervalMax = 30
	}
	if _, ok := cfg.Scheduler.Intervals["momentum_trader"]; !ok {
		cfg.Scheduler.Intervals["momentum_trader"] = StrategyIntervalConfig{
			MinSeconds: cfg.Strategy.MomentumTrader.ContinuousTickIntervalMin,
			MaxSeconds: cfg.Strategy.MomentumTrader.ContinuousTickIntervalMax,
		}
	}

	// Contrarian Trader defaults
	if cfg.Strategy.Contrarian.InactiveRate <= 0 {
		cfg.Strategy.Contrarian.InactiveRate = 0.15
	}
	if cfg.Strategy.Contrarian.MaxOrdersPerSession <= 0 {
		cfg.Strategy.Contrarian.MaxOrdersPerSession = 2
	}
	if cfg.Strategy.Contrarian.MaxLotsPerOrder <= 0 {
		cfg.Strategy.Contrarian.MaxLotsPerOrder = 8
	}
	if cfg.Strategy.Contrarian.DiscountThreshold <= 0 {
		cfg.Strategy.Contrarian.DiscountThreshold = 0.10
	}
	if cfg.Strategy.Contrarian.PremiumThreshold <= 0 {
		cfg.Strategy.Contrarian.PremiumThreshold = 0.10
	}
	if cfg.Strategy.Contrarian.ReferenceDeviationThreshold <= 0 {
		cfg.Strategy.Contrarian.ReferenceDeviationThreshold = 0.05
	}
	if cfg.Strategy.Contrarian.OpeningAuctionRate <= 0 {
		cfg.Strategy.Contrarian.OpeningAuctionRate = 0.10
	}
	if cfg.Strategy.Contrarian.ClosingAuctionRate <= 0 {
		cfg.Strategy.Contrarian.ClosingAuctionRate = 0.05
	}
	if cfg.Strategy.Contrarian.ContinuousTickIntervalMin <= 0 {
		cfg.Strategy.Contrarian.ContinuousTickIntervalMin = 30
	}
	if cfg.Strategy.Contrarian.ContinuousTickIntervalMax <= 0 {
		cfg.Strategy.Contrarian.ContinuousTickIntervalMax = 90
	}
	if _, ok := cfg.Scheduler.Intervals["contrarian"]; !ok {
		cfg.Scheduler.Intervals["contrarian"] = StrategyIntervalConfig{
			MinSeconds: cfg.Strategy.Contrarian.ContinuousTickIntervalMin,
			MaxSeconds: cfg.Strategy.Contrarian.ContinuousTickIntervalMax,
		}
	}

	// Event-Driven defaults
	if cfg.Strategy.EventDriven.InactiveRate <= 0 {
		cfg.Strategy.EventDriven.InactiveRate = 0.05 // sangat aktif
	}
	if cfg.Strategy.EventDriven.MaxOrdersPerSession <= 0 {
		cfg.Strategy.EventDriven.MaxOrdersPerSession = 5
	}
	if cfg.Strategy.EventDriven.MaxLotsPerOrder <= 0 {
		cfg.Strategy.EventDriven.MaxLotsPerOrder = 15
	}
	if cfg.Strategy.EventDriven.OpeningAuctionRate <= 0 {
		cfg.Strategy.EventDriven.OpeningAuctionRate = 0.30
	}
	if cfg.Strategy.EventDriven.ClosingAuctionRate <= 0 {
		cfg.Strategy.EventDriven.ClosingAuctionRate = 0.15
	}
	if cfg.Strategy.EventDriven.ContinuousTickIntervalMin <= 0 {
		cfg.Strategy.EventDriven.ContinuousTickIntervalMin = 5
	}
	if cfg.Strategy.EventDriven.ContinuousTickIntervalMax <= 0 {
		cfg.Strategy.EventDriven.ContinuousTickIntervalMax = 15
	}
	if _, ok := cfg.Scheduler.Intervals["event_driven"]; !ok {
		cfg.Scheduler.Intervals["event_driven"] = StrategyIntervalConfig{
			MinSeconds: cfg.Strategy.EventDriven.ContinuousTickIntervalMin,
			MaxSeconds: cfg.Strategy.EventDriven.ContinuousTickIntervalMax,
		}
	}

	// Market Maker defaults
	if cfg.Strategy.MarketMaker.InactiveRate <= 0 {
		cfg.Strategy.MarketMaker.InactiveRate = 0.05
	}
	if cfg.Strategy.MarketMaker.MaxOrdersPerSession <= 0 {
		cfg.Strategy.MarketMaker.MaxOrdersPerSession = 6
	}
	if cfg.Strategy.MarketMaker.MaxLotsPerOrder <= 0 {
		cfg.Strategy.MarketMaker.MaxLotsPerOrder = 10
	}
	if cfg.Strategy.MarketMaker.BaseSpreadTicks <= 0 {
		cfg.Strategy.MarketMaker.BaseSpreadTicks = 3
	}
	if cfg.Strategy.MarketMaker.MaxInventoryShares <= 0 {
		cfg.Strategy.MarketMaker.MaxInventoryShares = 5000
	}
	if cfg.Strategy.MarketMaker.OpeningAuctionRate <= 0 {
		cfg.Strategy.MarketMaker.OpeningAuctionRate = 0.50
	}
	if cfg.Strategy.MarketMaker.ClosingAuctionRate <= 0 {
		cfg.Strategy.MarketMaker.ClosingAuctionRate = 0.30
	}
	if cfg.Strategy.MarketMaker.ContinuousTickIntervalMin <= 0 {
		cfg.Strategy.MarketMaker.ContinuousTickIntervalMin = 10
	}
	if cfg.Strategy.MarketMaker.ContinuousTickIntervalMax <= 0 {
		cfg.Strategy.MarketMaker.ContinuousTickIntervalMax = 25
	}
	if _, ok := cfg.Scheduler.Intervals["market_maker"]; !ok {
		cfg.Scheduler.Intervals["market_maker"] = StrategyIntervalConfig{
			MinSeconds: cfg.Strategy.MarketMaker.ContinuousTickIntervalMin,
			MaxSeconds: cfg.Strategy.MarketMaker.ContinuousTickIntervalMax,
		}
	}

	// Value Investor defaults
	if cfg.Strategy.ValueInvestor.InactiveRate <= 0 {
		cfg.Strategy.ValueInvestor.InactiveRate = 0.40 // MOS mencari diskon tinggi, sering inaktif
	}
	if cfg.Strategy.ValueInvestor.MaxOrdersPerSession <= 0 {
		cfg.Strategy.ValueInvestor.MaxOrdersPerSession = 1
	}
	if cfg.Strategy.ValueInvestor.MaxLotsPerOrder <= 0 {
		cfg.Strategy.ValueInvestor.MaxLotsPerOrder = 5
	}
	if cfg.Strategy.ValueInvestor.DiscountThreshold <= 0 {
		cfg.Strategy.ValueInvestor.DiscountThreshold = 0.15
	}
	if cfg.Strategy.ValueInvestor.PremiumThreshold <= 0 {
		cfg.Strategy.ValueInvestor.PremiumThreshold = 0.15
	}
	if cfg.Strategy.ValueInvestor.OpeningAuctionRate <= 0 {
		cfg.Strategy.ValueInvestor.OpeningAuctionRate = 0.20
	}
	if cfg.Strategy.ValueInvestor.ClosingAuctionRate <= 0 {
		cfg.Strategy.ValueInvestor.ClosingAuctionRate = 0.10
	}
	if cfg.Strategy.ValueInvestor.ContinuousTickIntervalMin <= 0 {
		cfg.Strategy.ValueInvestor.ContinuousTickIntervalMin = 30
	}
	if cfg.Strategy.ValueInvestor.ContinuousTickIntervalMax <= 0 {
		cfg.Strategy.ValueInvestor.ContinuousTickIntervalMax = 90
	}
	if _, ok := cfg.Scheduler.Intervals["value_investor"]; !ok {
		cfg.Scheduler.Intervals["value_investor"] = StrategyIntervalConfig{
			MinSeconds: cfg.Strategy.ValueInvestor.ContinuousTickIntervalMin,
			MaxSeconds: cfg.Strategy.ValueInvestor.ContinuousTickIntervalMax,
		}
	}

	// Index Tracker defaults
	if cfg.Strategy.IndexTracker.InactiveRate <= 0 {
		cfg.Strategy.IndexTracker.InactiveRate = 0.10
	}
	if cfg.Strategy.IndexTracker.MaxOrdersPerSession <= 0 {
		cfg.Strategy.IndexTracker.MaxOrdersPerSession = 1
	}
	if cfg.Strategy.IndexTracker.MaxLotsPerOrder <= 0 {
		cfg.Strategy.IndexTracker.MaxLotsPerOrder = 8
	}
	if cfg.Strategy.IndexTracker.OpeningAuctionRate <= 0 {
		cfg.Strategy.IndexTracker.OpeningAuctionRate = 0.0 // Hanya aktif di closing
	}
	if cfg.Strategy.IndexTracker.ClosingAuctionRate <= 0 {
		cfg.Strategy.IndexTracker.ClosingAuctionRate = 0.80 // Sangat aktif di closing
	}
	if cfg.Strategy.IndexTracker.ContinuousTickIntervalMin <= 0 {
		cfg.Strategy.IndexTracker.ContinuousTickIntervalMin = 20
	}
	if cfg.Strategy.IndexTracker.ContinuousTickIntervalMax <= 0 {
		cfg.Strategy.IndexTracker.ContinuousTickIntervalMax = 60
	}
	if _, ok := cfg.Scheduler.Intervals["index_tracker"]; !ok {
		cfg.Scheduler.Intervals["index_tracker"] = StrategyIntervalConfig{
			MinSeconds: cfg.Strategy.IndexTracker.ContinuousTickIntervalMin,
			MaxSeconds: cfg.Strategy.IndexTracker.ContinuousTickIntervalMax,
		}
	}

	// Bandar defaults
	if cfg.Strategy.Bandar.InactiveRate <= 0 {
		cfg.Strategy.Bandar.InactiveRate = 0.20
	}
	if cfg.Strategy.Bandar.MaxOrdersPerSession <= 0 {
		cfg.Strategy.Bandar.MaxOrdersPerSession = 2
	}
	if cfg.Strategy.Bandar.MaxLotsPerOrder <= 0 {
		cfg.Strategy.Bandar.MaxLotsPerOrder = 50
	}
	if cfg.Strategy.Bandar.FairValueBrakeMultiplier <= 0 {
		cfg.Strategy.Bandar.FairValueBrakeMultiplier = 1.5
	}
	if cfg.Strategy.Bandar.BrakeDiscount <= 0 {
		cfg.Strategy.Bandar.BrakeDiscount = 0.50
	}
	if cfg.Strategy.Bandar.OpeningAuctionRate <= 0 {
		cfg.Strategy.Bandar.OpeningAuctionRate = 0.40
	}
	if cfg.Strategy.Bandar.ClosingAuctionRate <= 0 {
		cfg.Strategy.Bandar.ClosingAuctionRate = 0.20
	}
	if cfg.Strategy.Bandar.ContinuousTickIntervalMin <= 0 {
		cfg.Strategy.Bandar.ContinuousTickIntervalMin = 15
	}
	if cfg.Strategy.Bandar.ContinuousTickIntervalMax <= 0 {
		cfg.Strategy.Bandar.ContinuousTickIntervalMax = 45
	}
	if _, ok := cfg.Scheduler.Intervals["bandar"]; !ok {
		cfg.Scheduler.Intervals["bandar"] = StrategyIntervalConfig{
			MinSeconds: cfg.Strategy.Bandar.ContinuousTickIntervalMin,
			MaxSeconds: cfg.Strategy.Bandar.ContinuousTickIntervalMax,
		}
	}

	return &cfg, nil
}
