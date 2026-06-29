package portfolio

import (
	"errors"
	"testing"
)

func TestSequenceDuplicateAndGap(t *testing.T) {
	store := NewStore()
	store.Replace(Snapshot{AsOfSequence: 10, Accounts: []Account{{AccountID: "a"}}})
	if err := store.Apply(Event{EventID: "e11", Sequence: 11, AccountID: "a"}); err != nil {
		t.Fatal(err)
	}
	if err := store.Apply(Event{EventID: "e11", Sequence: 11, AccountID: "a"}); err != nil {
		t.Fatal(err)
	}
	if err := store.Apply(Event{EventID: "e13", Sequence: 13, AccountID: "a"}); !errors.Is(err, ErrSequenceGap) {
		t.Fatalf("expected sequence gap, got %v", err)
	}
	if store.LastSequence() != 11 {
		t.Fatalf("gap advanced checkpoint")
	}
}

func TestReconciliationDoesNotOverwrite(t *testing.T) {
	store := NewStore()
	store.Replace(Snapshot{Accounts: []Account{{AccountID: "a", Cash: Cash{AvailableIDR: 100}}}})
	mismatches := store.Compare(Snapshot{Accounts: []Account{{AccountID: "a", Cash: Cash{AvailableIDR: 90}}}})
	if len(mismatches) != 1 {
		t.Fatalf("expected mismatch")
	}
	account, _ := store.Account("a")
	if account.Cash.AvailableIDR != 100 {
		t.Fatalf("compare mutated local cache")
	}
}
