package domain

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
)

type Side string

const (
	SideBuy  Side = "buy"
	SideSell Side = "sell"
)

type OrderType string

const (
	OrderTypeLimit  OrderType = "limit"
	OrderTypeMarket OrderType = "market"
)

type OrderStatus string

const (
	OrderStatusAccepted             OrderStatus = "accepted"
	OrderStatusRejected             OrderStatus = "rejected"
	OrderStatusOpen                 OrderStatus = "open"
	OrderStatusAmended              OrderStatus = "amended"
	OrderStatusPartiallyFilled      OrderStatus = "partially_filled"
	OrderStatusFilled               OrderStatus = "filled"
	OrderStatusCancelled            OrderStatus = "cancelled"
	OrderStatusExpired              OrderStatus = "expired"
	OrderStatusLockedNonCancellable OrderStatus = "locked_non_cancellable"
)

type SessionStatus string

const (
	SessionClosed          SessionStatus = "closed"
	SessionPreOpen         SessionStatus = "pre_open"
	SessionOpeningAuction  SessionStatus = "opening_auction"
	SessionContinuous      SessionStatus = "continuous"
	SessionPreClose        SessionStatus = "pre_close"
	SessionRandomClosing   SessionStatus = "random_closing"
	SessionClosingAuction  SessionStatus = "closing_auction"
	SessionNonCancellation SessionStatus = "non_cancellation"
	SessionPostClosing     SessionStatus = "post_closing"
	SessionHalted          SessionStatus = "halted"
)

type Order struct {
	ID                string      `json:"id"`
	ClientOrderID     string      `json:"client_order_id"`
	BrokerCode        string      `json:"broker_code"`
	AccountID         string      `json:"account_id"`
	Symbol            string      `json:"symbol"`
	Side              Side        `json:"side"`
	OrderType         OrderType   `json:"order_type"`
	Price             int64       `json:"price"`
	OriginalQuantity  int64       `json:"original_quantity"`
	RemainingQuantity int64       `json:"remaining_quantity"`
	FilledQuantity    int64       `json:"filled_quantity"`
	Status            OrderStatus `json:"status"`
	RejectReason      string      `json:"reject_reason,omitempty"`
	IdempotencyKey    string      `json:"idempotency_key,omitempty"`
	SequenceNumber    int64       `json:"sequence_number"`
	CorrelationID     string      `json:"correlation_id,omitempty"`
	CreatedAt         time.Time   `json:"created_at"`
	UpdatedAt         time.Time   `json:"updated_at"`
}

func (o *Order) Clone() *Order {
	if o == nil {
		return nil
	}
	clone := *o
	return &clone
}

func (o *Order) IsActive() bool {
	return o.Status == OrderStatusOpen || o.Status == OrderStatusPartiallyFilled || o.Status == OrderStatusAmended
}

type Trade struct {
	ID             string    `json:"id"`
	SequenceNumber int64     `json:"sequence_number"`
	SessionID      string    `json:"session_id"`
	Symbol         string    `json:"symbol"`
	Price          int64     `json:"price"`
	Quantity       int64     `json:"quantity"`
	BuyOrderID     string    `json:"buy_order_id"`
	SellOrderID    string    `json:"sell_order_id"`
	BuyBrokerCode  string    `json:"buy_broker_code"`
	SellBrokerCode string    `json:"sell_broker_code"`
	BuyAccountID   string    `json:"buy_account_id"`
	SellAccountID  string    `json:"sell_account_id"`
	OccurredAt     time.Time `json:"occurred_at"`
	IdempotencyKey string    `json:"idempotency_key"`
}

type MarketSummary struct {
	Symbol    string `json:"symbol"`
	Open      int64  `json:"open"`
	High      int64  `json:"high"`
	Low       int64  `json:"low"`
	Close     int64  `json:"close"`
	Last      int64  `json:"last"`
	Volume    int64  `json:"volume"`
	Value     int64  `json:"value"`
	Frequency int64  `json:"frequency"`
}

type BookLevel struct {
	Price    int64 `json:"price"`
	Quantity int64 `json:"quantity"`
	Orders   int   `json:"orders"`
}

type BookSnapshot struct {
	Symbol string      `json:"symbol"`
	Bids   []BookLevel `json:"bids"`
	Asks   []BookLevel `json:"asks"`
}

type IndicativePriceVolume struct {
	Symbol         string    `json:"symbol"`
	Price          int64     `json:"price"`
	Volume         int64     `json:"volume"`
	Imbalance      int64     `json:"imbalance"`
	ReferencePrice int64     `json:"reference_price"`
	CalculatedAt   time.Time `json:"calculated_at"`
}

type NumericInt int64

func (n *NumericInt) UnmarshalJSON(data []byte) error {
	var raw any
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	value, err := numericToInt(raw)
	if err != nil {
		return err
	}
	*n = NumericInt(value)
	return nil
}

type NumericFloat float64

func (n *NumericFloat) UnmarshalJSON(data []byte) error {
	var raw any
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	value, err := numericToFloat(raw)
	if err != nil {
		return err
	}
	*n = NumericFloat(value)
	return nil
}

// NullableNumericInt is like NumericInt but tolerates JSON null (treated as 0).
// Used for open-ended range fields from BEI such as max_price and max_reference_price.
type NullableNumericInt struct {
	Value  int64
	IsNull bool
}

func (n *NullableNumericInt) UnmarshalJSON(data []byte) error {
	var raw any
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	if raw == nil {
		n.IsNull = true
		n.Value = 0
		return nil
	}
	value, err := numericToInt(raw)
	if err != nil {
		return err
	}
	n.IsNull = false
	n.Value = value
	return nil
}

func (n NullableNumericInt) Int64() int64 {
	return n.Value
}

// NullableNumericFloat is like NumericFloat but tolerates JSON null (treated as 0).
// Used for open-ended fields from BEI such as max_listed_shares_percent.
type NullableNumericFloat struct {
	Value  float64
	IsNull bool
}

func (n *NullableNumericFloat) UnmarshalJSON(data []byte) error {
	var raw any
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	if raw == nil {
		n.IsNull = true
		n.Value = 0
		return nil
	}
	value, err := numericToFloat(raw)
	if err != nil {
		return err
	}
	n.IsNull = false
	n.Value = value
	return nil
}

func (n NullableNumericFloat) Float64() float64 {
	return n.Value
}

func numericToInt(value any) (int64, error) {
	floatValue, err := numericToFloat(value)
	if err != nil {
		return 0, err
	}
	return int64(math.Round(floatValue)), nil
}

func numericToFloat(value any) (float64, error) {
	switch typed := value.(type) {
	case float64:
		return typed, nil
	case string:
		trimmed := strings.TrimSpace(typed)
		if trimmed == "" {
			return 0, nil
		}
		parsed, err := strconv.ParseFloat(trimmed, 64)
		if err != nil {
			return 0, fmt.Errorf("invalid numeric string %q: %w", typed, err)
		}
		return parsed, nil
	default:
		return 0, fmt.Errorf("unsupported numeric value %T", value)
	}
}
