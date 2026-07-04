package portfolio

import (
	"encoding/json"
	"strconv"
	"time"
)

type Cash struct {
	AvailableIDR int64 `json:"available_idr"`
	ReservedIDR  int64 `json:"reserved_idr"`
	PendingIDR   int64 `json:"pending_idr"`
}

func (c *Cash) UnmarshalJSON(data []byte) error {
	var aux struct {
		AvailableIDR interface{} `json:"available_idr"`
		ReservedIDR  interface{} `json:"reserved_idr"`
		PendingIDR   interface{} `json:"pending_idr"`
	}
	if err := json.Unmarshal(data, &aux); err != nil {
		return err
	}
	c.AvailableIDR = ParseFlexInt64(aux.AvailableIDR)
	c.ReservedIDR = ParseFlexInt64(aux.ReservedIDR)
	c.PendingIDR = ParseFlexInt64(aux.PendingIDR)
	return nil
}

type Position struct {
	Symbol          string `json:"symbol"`
	AvailableShares int64  `json:"available_shares"`
	ReservedShares  int64  `json:"reserved_shares"`
	PendingShares   int64  `json:"pending_shares"`
	AveragePriceIDR int64  `json:"average_price_idr"`
}

func (p *Position) UnmarshalJSON(data []byte) error {
	var aux struct {
		Symbol          string      `json:"symbol"`
		AvailableShares interface{} `json:"available_shares"`
		ReservedShares  interface{} `json:"reserved_shares"`
		PendingShares   interface{} `json:"pending_shares"`
		AveragePriceIDR interface{} `json:"average_price_idr"`
	}
	if err := json.Unmarshal(data, &aux); err != nil {
		return err
	}
	p.Symbol = aux.Symbol
	p.AvailableShares = ParseFlexInt64(aux.AvailableShares)
	p.ReservedShares = ParseFlexInt64(aux.ReservedShares)
	p.PendingShares = ParseFlexInt64(aux.PendingShares)
	p.AveragePriceIDR = ParseFlexInt64(aux.AveragePriceIDR)
	return nil
}

type OpenOrder struct {
	OrderID              string    `json:"order_id"`
	ClientOrderID        string    `json:"client_order_id"`
	Symbol               string    `json:"symbol"`
	Side                 string    `json:"side"`
	Status               string    `json:"status"`
	QuantityShares       int64     `json:"quantity_shares"`
	FilledQuantityShares int64     `json:"filled_quantity_shares"`
	EntityVersion        int64     `json:"entity_version"`
	CreatedAt            time.Time `json:"created_at"`
}

type Account struct {
	AccountID  string      `json:"account_id"`
	Cash       Cash        `json:"cash"`
	Positions  []Position  `json:"positions"`
	OpenOrders []OpenOrder `json:"open_orders"`
}

type Snapshot struct {
	AsOfSequence int64     `json:"as_of_sequence"`
	GeneratedAt  time.Time `json:"generated_at"`
	Accounts     []Account `json:"accounts"`
}

type Event struct {
	EventID       string          `json:"event_id"`
	Sequence      int64           `json:"sequence"`
	AccountID     string          `json:"account_id"`
	EventType     string          `json:"event_type"`
	EntityID      string          `json:"entity_id"`
	EntityVersion int64           `json:"entity_version"`
	OccurredAt    time.Time       `json:"occurred_at"`
	CorrelationID string          `json:"correlation_id"`
	Payload       json.RawMessage `json:"payload"`
}

func ParseFlexInt64(val interface{}) int64 {
	switch v := val.(type) {
	case float64:
		return int64(v)
	case int64:
		return v
	case int:
		return int64(v)
	case string:
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return int64(f)
		}
	}
	return 0
}
