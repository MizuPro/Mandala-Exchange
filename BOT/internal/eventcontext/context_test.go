package eventcontext

import (
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
)

func publicAnnouncement(now time.Time) Announcement {
	return Announcement{
		ID: uuid.New(), IssuerID: uuid.New(), SecurityID: uuid.New(),
		Symbol: "bbca", Type: "corporate_action", Title: "Stock split",
		PublishedAt: now.Add(-time.Minute), ReceivedAt: now,
		Metadata: map[string]any{},
	}
}

func TestBEIPublicationGatesReactionTime(t *testing.T) {
	now := time.Date(2026, 7, 1, 9, 0, 0, 0, time.UTC)
	store := NewStore()
	announcement := publicAnnouncement(now)
	context, err := store.IngestBEI(announcement, 2*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	want := announcement.PublishedAt.Add(2 * time.Minute)
	if context.ReactionStartAt != want || context.Source != "bei_public_announcement" ||
		context.SimulationOnly {
		t.Fatalf("unexpected reaction context: %+v", context)
	}
}

func TestBEIGateRejectsFutureUnpublishedAndSimulationEvent(t *testing.T) {
	now := time.Now()
	tests := []struct {
		name   string
		mutate func(*Announcement)
		want   error
	}{
		{"future", func(a *Announcement) { a.PublishedAt = now.Add(time.Second) }, ErrFutureInformation},
		{"missing publication", func(a *Announcement) { a.PublishedAt = time.Time{} }, ErrUnpublishedEvent},
		{"simulation metadata", func(a *Announcement) { a.Metadata["simulation_only"] = true }, nil},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			announcement := publicAnnouncement(now)
			test.mutate(&announcement)
			_, err := NewStore().IngestBEI(announcement, 0)
			if err == nil {
				t.Fatal("invalid announcement accepted")
			}
			if test.want != nil && !errors.Is(err, test.want) {
				t.Fatalf("error = %v, want %v", err, test.want)
			}
		})
	}
}

func TestSnapshotPollingIsIdempotent(t *testing.T) {
	now := time.Date(2026, 7, 1, 10, 0, 0, 0, time.UTC)
	id, issuerID := uuid.New(), uuid.New()
	raw := []byte(`[{"id":"` + id.String() + `","issuer_id":"` + issuerID.String() +
		`","security_id":null,"symbol":"TLKM","type":"news","title":"Public news",` +
		`"published_at":"2026-07-01T09:59:00Z","metadata":{}}]`)
	store := NewStore()
	accepted, err := store.IngestBEISnapshot(raw, now, time.Second)
	if err != nil || accepted != 1 {
		t.Fatalf("first poll = %d, %v", accepted, err)
	}
	accepted, err = store.IngestBEISnapshot(raw, now.Add(time.Second), time.Second)
	if err != nil || accepted != 0 {
		t.Fatalf("duplicate poll = %d, %v", accepted, err)
	}
}

func TestPanicSellerOnlyValidAsSimulationScenarioActor(t *testing.T) {
	actor := ScenarioActor{
		ID: uuid.New(), Type: "panic_seller", SimulationOnly: true,
		Symbols: []string{"BBCA"}, Duration: 15 * time.Minute, MaxTotalLots: 5000,
	}
	if err := ValidateScenarioActor(ModeStressTest, actor); err != nil {
		t.Fatalf("valid stress actor rejected: %v", err)
	}
	if err := ValidateScenarioActor(ModeLive, actor); !errors.Is(err, ErrSimulationOnly) {
		t.Fatalf("live panic seller error = %v", err)
	}
	actor.SimulationOnly = false
	if err := ValidateScenarioActor(ModeStressTest, actor); err == nil {
		t.Fatal("non-simulation panic seller accepted")
	}
}
