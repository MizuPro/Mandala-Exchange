package main

import (
	"math"
	"testing"

	"github.com/pressly/goose/v3"
)

func TestMigrationFilesAreValidAndSequential(t *testing.T) {
	migrations, err := goose.CollectMigrations("../../migrations", 0, math.MaxInt64)
	if err != nil {
		t.Fatal(err)
	}
	if len(migrations) != 9 {
		t.Fatalf("expected 9 migrations, found %d", len(migrations))
	}
	for index, migration := range migrations {
		want := int64(index + 1)
		if migration.Version != want {
			t.Fatalf("migration index %d has version %d, want %d", index, migration.Version, want)
		}
	}
}
