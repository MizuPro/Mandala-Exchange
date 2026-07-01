package decision

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

type memoryStore struct {
	mu        sync.Mutex
	logs      []DecisionLog
	failCount int
	cleaned   int
}

func (s *memoryStore) Insert(_ context.Context, logs []DecisionLog) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failCount > 0 {
		s.failCount--
		return errors.New("temporary database failure")
	}
	s.logs = append(s.logs, logs...)
	return nil
}

func (s *memoryStore) Cleanup(_ context.Context, retain int) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cleaned = retain
	return 3, nil
}

func testConfig() Config {
	return Config{
		BatchSize: 100, FlushInterval: time.Second, HoldSampleRate: 0.02,
		RetentionSessions: 30, BufferCapacity: 100,
	}
}

func TestConfigValidation(t *testing.T) {
	valid := testConfig()
	if err := valid.Validate(); err != nil {
		t.Fatal(err)
	}
	tests := []Config{
		{BatchSize: 99, FlushInterval: time.Second, RetentionSessions: 30, BufferCapacity: 100},
		{BatchSize: 501, FlushInterval: time.Second, RetentionSessions: 30, BufferCapacity: 501},
		{BatchSize: 100, FlushInterval: time.Second - 1, RetentionSessions: 30, BufferCapacity: 100},
		{BatchSize: 100, FlushInterval: 5*time.Second + 1, RetentionSessions: 30, BufferCapacity: 100},
		{BatchSize: 100, FlushInterval: time.Second, HoldSampleRate: -0.1, RetentionSessions: 30, BufferCapacity: 100},
		{BatchSize: 100, FlushInterval: time.Second, HoldSampleRate: 1.1, RetentionSessions: 30, BufferCapacity: 100},
		{BatchSize: 100, FlushInterval: time.Second, RetentionSessions: 0, BufferCapacity: 100},
	}
	for i, cfg := range tests {
		if err := cfg.Validate(); err == nil {
			t.Errorf("case %d: expected validation error", i)
		}
	}
}

func TestPipelineDrainsAllMaterialLogsOnClose(t *testing.T) {
	s := &memoryStore{}
	p, err := newPipeline(s, testConfig(), func() float64 { return 0 })
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 250; i++ {
		if err := p.Record(context.Background(), DecisionLog{
			Action: ActionPlaceOrder, Symbol: "BBCA",
		}); err != nil {
			t.Fatal(err)
		}
	}
	p.Close()
	if got := len(s.logs); got != 250 {
		t.Fatalf("expected 250 durable logs, got %d", got)
	}
}

func TestPipelineRetainsFailedBatchAndRetries(t *testing.T) {
	s := &memoryStore{failCount: 1}
	p, err := newPipeline(s, testConfig(), func() float64 { return 0 })
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 100; i++ {
		if err := p.Record(context.Background(), DecisionLog{Action: ActionReject}); err != nil {
			t.Fatal(err)
		}
	}
	p.Close()
	if got := len(s.logs); got != 100 {
		t.Fatalf("expected failed batch to be retried, got %d logs", got)
	}
}

func TestPipelineCloseContextReportsPersistentStoreFailure(t *testing.T) {
	s := &memoryStore{failCount: 1000}
	p, err := newPipeline(s, testConfig(), func() float64 { return 0 })
	if err != nil {
		t.Fatal(err)
	}
	if err := p.Record(context.Background(), DecisionLog{Action: ActionReject}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	if err := p.CloseContext(ctx); err == nil {
		t.Fatal("expected persistent shutdown flush failure")
	}
}

func TestPipelineSupportsZeroAndFullHoldSampling(t *testing.T) {
	zeroCfg := testConfig()
	zeroCfg.HoldSampleRate = 0
	zeroStore := &memoryStore{}
	zero, err := newPipeline(zeroStore, zeroCfg, func() float64 { return 0 })
	if err != nil {
		t.Fatal(err)
	}
	if err := zero.Record(context.Background(), DecisionLog{Action: ActionHold}); err != nil {
		t.Fatal(err)
	}
	zero.Close()
	if len(zeroStore.logs) != 0 {
		t.Fatal("0% HOLD sampling persisted a record")
	}

	fullCfg := testConfig()
	fullCfg.HoldSampleRate = 1
	fullStore := &memoryStore{}
	full, err := newPipeline(fullStore, fullCfg, func() float64 { return 0.999 })
	if err != nil {
		t.Fatal(err)
	}
	if err := full.Record(context.Background(), DecisionLog{Action: ActionHold}); err != nil {
		t.Fatal(err)
	}
	full.Close()
	if len(fullStore.logs) != 1 {
		t.Fatal("100% HOLD sampling did not persist a record")
	}
}

func TestPipelineRedactsNestedSecrets(t *testing.T) {
	s := &memoryStore{}
	p, err := newPipeline(s, testConfig(), func() float64 { return 0 })
	if err != nil {
		t.Fatal(err)
	}
	if err := p.Record(context.Background(), DecisionLog{
		Action: ActionPlaceOrder,
		ContextSnapshot: map[string]interface{}{
			"public": "ok",
			"nested": map[string]interface{}{"access_token": "highly-secret-token"},
			"array":  []interface{}{map[string]interface{}{"password": "password-value"}},
		},
	}); err != nil {
		t.Fatal(err)
	}
	p.Close()
	nested := s.logs[0].ContextSnapshot["nested"].(map[string]interface{})
	if nested["access_token"] == "highly-secret-token" {
		t.Fatal("nested token was not redacted")
	}
	array := s.logs[0].ContextSnapshot["array"].([]interface{})
	if array[0].(map[string]interface{})["password"] == "password-value" {
		t.Fatal("password inside array was not redacted")
	}
}

func TestPipelineCleanupUsesConfiguredRetention(t *testing.T) {
	s := &memoryStore{}
	p, err := newPipeline(s, testConfig(), func() float64 { return 0 })
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	affected, err := p.CleanupOldLogs(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if affected != 3 || s.cleaned != 30 {
		t.Fatalf("unexpected cleanup result: affected=%d retain=%d", affected, s.cleaned)
	}
}

func TestPipelineRejectsRecordAfterClose(t *testing.T) {
	s := &memoryStore{}
	p, err := newPipeline(s, testConfig(), func() float64 { return 0 })
	if err != nil {
		t.Fatal(err)
	}
	p.Close()
	if err := p.Record(context.Background(), DecisionLog{Action: ActionReject}); !errors.Is(err, ErrClosed) {
		t.Fatalf("expected ErrClosed, got %v", err)
	}
}

func ptr[T any](value T) *T { return &value }

func TestDecisionLogSupportsNormativeFields(t *testing.T) {
	id := uuid.New()
	entry := DecisionLog{
		InternalID: &id, SimulationRunID: &id, SessionInstanceID: &id,
		VirtualDayIndex: ptr[int64](42), Strategy: "noise_trader", Symbol: "BBCA",
		SessionStatus: "continuous", Action: ActionReject, DecisionReason: "invalid_tick",
		OrderSubmitted: true, ClientOrderID: ptr("client-id"), SekuritasOrderID: ptr("order-id"),
		OrderPriceIDR: ptr[int64](1000), OrderQuantity: ptr[int64](100),
		OrderStatus: ptr("rejected"), RejectReason: ptr("INVALID_TICK"),
	}
	if entry.InternalID == nil || entry.RejectReason == nil {
		t.Fatal("normative fields were not retained")
	}
}
