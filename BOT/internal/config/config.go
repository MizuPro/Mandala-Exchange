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
	NoiseTrader NoiseTraderConfig `yaml:"noise_trader"`
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

	return &cfg, nil
}
