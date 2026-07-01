package risk_test

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/Mandala-Exchange/BOT/internal/client/sekuritas"
	"github.com/Mandala-Exchange/BOT/internal/risk"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type livePrices struct{}

func (livePrices) LastPriceIDR(symbol string) (int64, bool) {
	if symbol == "BARA" {
		return 190, true
	}
	return 0, false
}
func (livePrices) LotSize(symbol string) (int64, bool) {
	if symbol == "BARA" {
		return 100, true
	}
	return 0, false
}

func TestLiveForcedLiquidationAndPermanentBankruptcy(t *testing.T) {
	databaseURL := os.Getenv("BOT_TEST_DATABASE_URL")
	sekuritasURL := os.Getenv("SEKURITAS_INTEGRATION_URL")
	serviceToken := os.Getenv("BOT_INTEGRATION_SERVICE_TOKEN")
	if databaseURL == "" || sekuritasURL == "" || serviceToken == "" {
		t.Skip("live Task 3.3 integration environment not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	runID := uuid.NewString()
	liquidatingBotID := "risk-liquidating-" + runID
	bankruptBotID := "risk-bankrupt-" + runID
	client := sekuritas.NewClient(sekuritasURL, serviceToken)
	provision, err := client.ProvisionBots(ctx, sekuritas.ProvisionBatchRequest{Bots: []sekuritas.ProvisionBotRequest{
		{ExternalBotID: liquidatingBotID, Email: liquidatingBotID + "@bot.local", DisplayName: liquidatingBotID, Tier: "retail", Strategy: "noise_trader"},
		{ExternalBotID: bankruptBotID, Email: bankruptBotID + "@bot.local", DisplayName: bankruptBotID, Tier: "retail", Strategy: "noise_trader"},
	}}, "risk-provision-"+runID)
	if err != nil {
		t.Fatal(err)
	}
	if len(provision.Results) != 2 {
		t.Fatalf("expected two provisioned bots, got %+v", provision.Results)
	}
	liquidatingAccount := provision.Results[0].AccountID
	bankruptAccount := provision.Results[1].AccountID
	genesisID := uuid.NewString()
	err = client.TriggerGenesis(ctx, map[string]interface{}{
		"genesis_run_id": genesisID,
		"accounts": []map[string]interface{}{
			{
				"external_bot_id": liquidatingBotID, "account_id": liquidatingAccount, "cash_idr": int64(0),
				"positions": []map[string]interface{}{{"symbol": "BARA", "quantity_shares": int64(200), "average_price_idr": int64(190)}},
			},
			{
				"external_bot_id": bankruptBotID, "account_id": bankruptAccount, "cash_idr": int64(0),
				"positions": []map[string]interface{}{},
			},
		},
	}, "risk-genesis-"+runID)
	if err != nil {
		t.Fatal(err)
	}
	if err := client.FetchTokens(ctx, []string{liquidatingAccount, bankruptAccount}, "risk-tokens-"+runID); err != nil {
		t.Fatal(err)
	}
	snapshot, err := client.BulkSnapshot(ctx, []string{liquidatingAccount, bankruptAccount})
	if err != nil {
		t.Fatal(err)
	}
	accounts := make(map[string]struct {
		index int
	})
	for index, account := range snapshot.Accounts {
		accounts[account.AccountID] = struct{ index int }{index}
	}
	liquidatingIndex, ok := accounts[liquidatingAccount]
	if !ok {
		t.Fatal("liquidating account missing from authoritative snapshot")
	}
	bankruptIndex, ok := accounts[bankruptAccount]
	if !ok {
		t.Fatal("bankrupt account missing from authoritative snapshot")
	}

	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	for _, item := range []struct{ botID, accountID string }{
		{liquidatingBotID, liquidatingAccount}, {bankruptBotID, bankruptAccount},
	} {
		if _, err := pool.Exec(ctx, `
			INSERT INTO bots(external_bot_id, strategy_type, status, sekuritas_account_id)
			VALUES ($1, 'noise_trader', 'active', $2)
			ON CONFLICT(external_bot_id) DO UPDATE SET status='active', sekuritas_account_id=EXCLUDED.sekuritas_account_id`,
			item.botID, item.accountID); err != nil {
			t.Fatal(err)
		}
		defer pool.Exec(context.Background(), `DELETE FROM bots WHERE external_bot_id=$1`, item.botID)
	}

	repository := risk.NewPostgresRepository(ctx, pool)
	engine := risk.NewEngine(repository, livePrices{})
	limits := risk.Limits{
		MaxSymbolExposurePct: .30, MaxDailyLossPct: .05, MaxWeeklyLossPct: .15,
		MaxInventoryShares: 10_000, MaxLiquidationShares: 100,
	}
	sessionID := uuid.NewString()
	liquidation, err := engine.Evaluate(
		risk.State{BotID: liquidatingBotID, AccountID: liquidatingAccount, Status: risk.StatusActive},
		snapshot.Accounts[liquidatingIndex.index], limits, sessionID, 1,
	)
	if err != nil {
		t.Fatal(err)
	}
	if liquidation.State.Status != risk.StatusLiquidating || len(liquidation.LiquidationOrders) != 1 {
		t.Fatalf("expected forced liquidation, got %+v", liquidation)
	}
	order := liquidation.LiquidationOrders[0]
	clientOrderID := fmt.Sprintf("bot:%s:%s:1", liquidatingBotID, sessionID)
	response, err := client.PlaceOrder(ctx, liquidatingAccount, sekuritas.PlaceOrderRequest{
		ClientOrderID: clientOrderID, Symbol: order.Symbol, Side: "sell",
		OrderType: "market", Quantity: order.QuantityShares,
	})
	if err != nil {
		t.Fatal(err)
	}
	if response.ID == "" || response.ClientOrderID != clientOrderID {
		t.Fatalf("invalid liquidation response: %+v", response)
	}

	bankruptcy, err := engine.Evaluate(
		risk.State{BotID: bankruptBotID, AccountID: bankruptAccount, Status: risk.StatusActive},
		snapshot.Accounts[bankruptIndex.index], limits, sessionID, 1,
	)
	if err != nil {
		t.Fatal(err)
	}
	if bankruptcy.State.Status != risk.StatusBankrupt {
		t.Fatalf("expected bankruptcy, got %+v", bankruptcy.State)
	}
	var persistedStatus string
	if err := pool.QueryRow(ctx, `SELECT status FROM bots WHERE external_bot_id=$1`, bankruptBotID).Scan(&persistedStatus); err != nil {
		t.Fatal(err)
	}
	if persistedStatus != "bankrupt" {
		t.Fatalf("bankruptcy not persisted: %s", persistedStatus)
	}
	reloaded, err := repository.Load(bankruptBotID)
	if err != nil || reloaded.Status != risk.StatusBankrupt {
		t.Fatalf("bankruptcy did not survive restart load: state=%+v err=%v", reloaded, err)
	}
	again, err := engine.Evaluate(reloaded, snapshot.Accounts[bankruptIndex.index], limits, uuid.NewString(), 2)
	if err != nil || again.State.Status != risk.StatusBankrupt {
		t.Fatalf("terminal bankruptcy illegally reactivated: %+v err=%v", again.State, err)
	}
}
