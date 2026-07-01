package reconciliation

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/Mandala-Exchange/BOT/internal/portfolio"
)

type snapshotClient struct {
	accounts map[string]portfolio.Account
	sequence int64
	calls    [][]string
	errAt    int
}

func (c *snapshotClient) BulkSnapshot(_ context.Context, accountIDs []string) (portfolio.Snapshot, error) {
	c.calls = append(c.calls, append([]string(nil), accountIDs...))
	if c.errAt > 0 && len(c.calls) == c.errAt {
		return portfolio.Snapshot{}, errors.New("Sekuritas unavailable")
	}
	snapshot := portfolio.Snapshot{
		AsOfSequence: c.sequence,
		GeneratedAt:  time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC),
	}
	for _, accountID := range accountIDs {
		snapshot.Accounts = append(snapshot.Accounts, c.accounts[accountID])
	}
	return snapshot, nil
}

func TestRecoverReturnsLocalAccountingToSekuritasSnapshot(t *testing.T) {
	client := &snapshotClient{accounts: map[string]portfolio.Account{}, sequence: 91}
	accountIDs := make([]string, 0, 150)
	for index := 0; index < 150; index++ {
		id := fmt.Sprintf("account-%03d", index)
		accountIDs = append(accountIDs, id)
		client.accounts[id] = portfolio.Account{
			AccountID: id,
			Cash: portfolio.Cash{
				AvailableIDR: int64(1_000_000 + index),
				ReservedIDR:  int64(index),
				PendingIDR:   int64(index * 2),
			},
			Positions: []portfolio.Position{{
				Symbol: "BBCA", AvailableShares: int64(100 + index),
			}},
		}
	}
	store := portfolio.NewStore()
	store.Replace(portfolio.Snapshot{
		AsOfSequence: 80,
		Accounts: []portfolio.Account{{
			AccountID: "account-000",
			Cash:      portfolio.Cash{AvailableIDR: 1},
		}},
	})
	reconciler := NewReconciler(client, store, accountIDs, time.Minute)
	if err := reconciler.Once(context.Background()); err == nil {
		t.Fatal("stale local accounting was not detected")
	}
	client.calls = nil
	if err := reconciler.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(client.calls) != 2 || len(client.calls[0]) != 100 || len(client.calls[1]) != 50 {
		t.Fatalf("recovery did not use bounded batches: %+v", client.calls)
	}
	if store.LastSequence() != 91 {
		t.Fatalf("checkpoint=%d, want authoritative 91", store.LastSequence())
	}
	client.calls = nil
	if err := reconciler.Once(context.Background()); err != nil {
		t.Fatalf("local accounting differs after recovery: %v", err)
	}
	for _, accountID := range accountIDs {
		got, ok := store.Account(accountID)
		if !ok {
			t.Fatalf("account %s missing after recovery", accountID)
		}
		want := client.accounts[accountID]
		if got.Cash != want.Cash ||
			len(got.Positions) != 1 || len(want.Positions) != 1 ||
			got.Positions[0].AvailableShares != want.Positions[0].AvailableShares {
			t.Fatalf("account %s mismatch after recovery: got=%+v want=%+v", accountID, got, want)
		}
	}
}

func TestRecoverIsAtomicWhenLaterBatchFails(t *testing.T) {
	client := &snapshotClient{accounts: map[string]portfolio.Account{}, sequence: 20, errAt: 2}
	var accountIDs []string
	for index := 0; index < 101; index++ {
		id := fmt.Sprintf("account-%03d", index)
		accountIDs = append(accountIDs, id)
		client.accounts[id] = portfolio.Account{AccountID: id, Cash: portfolio.Cash{AvailableIDR: 500}}
	}
	store := portfolio.NewStore()
	store.Replace(portfolio.Snapshot{AsOfSequence: 10, Accounts: []portfolio.Account{{
		AccountID: "existing", Cash: portfolio.Cash{AvailableIDR: 999},
	}}})
	reconciler := NewReconciler(client, store, accountIDs, time.Minute)
	if err := reconciler.Recover(context.Background()); err == nil {
		t.Fatal("expected second batch failure")
	}
	existing, ok := store.Account("existing")
	if !ok || existing.Cash.AvailableIDR != 999 || store.LastSequence() != 10 {
		t.Fatalf("partial recovery mutated cache: account=%+v sequence=%d", existing, store.LastSequence())
	}
}
