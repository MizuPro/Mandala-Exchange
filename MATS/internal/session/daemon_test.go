package session

import (
	"testing"
	"time"
)

func TestResumedSegmentStartedAtRejectsSessionTotalAsSegmentRemaining(t *testing.T) {
	now := time.Date(2026, 7, 4, 13, 0, 0, 0, time.UTC)

	got := resumedSegmentStartedAt(now, 3, 300)
	if !got.Equal(now) {
		t.Fatalf("invalid remaining time must restart the segment clock: got %s want %s", got, now)
	}
}

func TestResumedSegmentStartedAtUsesValidRemainingTime(t *testing.T) {
	now := time.Date(2026, 7, 4, 13, 0, 0, 0, time.UTC)

	got := resumedSegmentStartedAt(now, 27, 10)
	want := now.Add(-17 * time.Second)
	if !got.Equal(want) {
		t.Fatalf("unexpected resumed start: got %s want %s", got, want)
	}
}
