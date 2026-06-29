package session

import (
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestRolloverAndVirtualClock(t *testing.T) {
	monitor := NewMonitor()
	first := SessionInstance{InstanceID: uuid.New(), VirtualDayIndex: 1, VirtualDurationSecs: 21600, RealDurationSecs: 1800}
	second := SessionInstance{InstanceID: uuid.New(), VirtualDayIndex: 2, VirtualDurationSecs: 21600, RealDurationSecs: 1800}
	rollovers := 0
	monitor.OnRollover(func(previous, current SessionInstance) { rollovers++ })
	monitor.UpdateInstance(&first)
	monitor.UpdateInstance(&first)
	monitor.UpdateInstance(&second)
	if rollovers != 1 {
		t.Fatalf("expected exactly one rollover, got %d", rollovers)
	}
	if delay := monitor.VirtualToRealDelay(12 * time.Minute); delay != time.Minute {
		t.Fatalf("unexpected compressed delay %s", delay)
	}
}
