package sekuritas

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestPlaceOrderUsesBotJWTAndStableClientID(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/orders" || r.Header.Get("authorization") != "Bearer jwt-value" {
			t.Fatalf("unexpected request path/auth: %s %s", r.URL.Path, r.Header.Get("authorization"))
		}
		var request PlaceOrderRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatal(err)
		}
		if request.ClientOrderID != "bot:test:11111111-1111-1111-1111-111111111111:1" || request.Side != "sell" {
			t.Fatalf("unexpected order request: %+v", request)
		}
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"id":"order-1","client_order_id":"bot:test:11111111-1111-1111-1111-111111111111:1","status":"open"}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "service-token")
	client.tokenCache["account-1"] = "jwt-value"
	client.tokenExpiry["account-1"] = time.Now().Add(time.Hour)
	result, err := client.PlaceOrder(context.Background(), "account-1", PlaceOrderRequest{
		ClientOrderID: "bot:test:11111111-1111-1111-1111-111111111111:1",
		Symbol:        "BBCA", Side: "sell", OrderType: "market", Quantity: 100,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.ID != "order-1" {
		t.Fatalf("unexpected response: %+v", result)
	}
}

func TestPlaceOrderInvalidSuccessResponseIsSubmitUnknown(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"id":`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "service-token")
	client.tokenCache["account-1"] = "jwt-value"
	client.tokenExpiry["account-1"] = time.Now().Add(time.Hour)
	_, err := client.PlaceOrder(context.Background(), "account-1", PlaceOrderRequest{
		ClientOrderID: "bot:test:session:1", Symbol: "BBCA", Side: "buy",
		OrderType: "limit", PriceIDR: 100, Quantity: 100,
	})
	if !errors.Is(err, ErrOrderSubmitUnknown) {
		t.Fatalf("expected submit_unknown sentinel, got %v", err)
	}
}

func TestPlaceOrderFailsWithoutAccountToken(t *testing.T) {
	client := NewClient("http://127.0.0.1", "service-token")
	if _, err := client.PlaceOrder(context.Background(), "missing", PlaceOrderRequest{}); err != ErrTokenNotFound {
		t.Fatalf("expected token error, got %v", err)
	}
}
