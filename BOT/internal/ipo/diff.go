package ipo

import (
	bei "github.com/Mandala-Exchange/bot-v2/internal/client/bei"
)

// DiffResult adalah hasil perbandingan antara data IPO baru dari poll dengan state registry.
type DiffResult struct {
	NewEvents      []bei.IPOLifecycle // event baru yang belum ada di registry
	VersionUpdated []bei.IPOLifecycle // event yang version-nya lebih baru dari registry
	NowListed      []bei.IPOLifecycle // event yang baru berpindah ke status "listed"
	NowCancelled   []bei.IPOLifecycle // event yang baru berpindah ke status "cancelled"
}

// Diff membandingkan incoming IPO list dari poll dengan registry saat ini.
// Mengembalikan DiffResult yang berisi kategori perubahan yang perlu diproses.
//
// Invariant: IPO yang baru menjadi "listed" atau "cancelled" dikembalikan dalam kategori
// masing-masing agar consumer dapat bereaksi (update universe, bersihkan pending decision).
func Diff(reg *IPORegistry, incoming []bei.IPOLifecycle) DiffResult {
	var result DiffResult

	for _, ipo := range incoming {
		existing, ok := reg.Get(ipo.ID)
		if !ok {
			// Entry baru sama sekali
			result.NewEvents = append(result.NewEvents, ipo)
			continue
		}

		// Cek transisi status khusus (bisa terjadi bersamaan dengan version update)
		prevStatus := existing.Lifecycle.Status
		if prevStatus != "listed" && ipo.Status == "listed" {
			result.NowListed = append(result.NowListed, ipo)
		}
		if prevStatus != "cancelled" && ipo.Status == "cancelled" {
			result.NowCancelled = append(result.NowCancelled, ipo)
		}

		// Cek version update
		if ipo.Version > existing.Lifecycle.Version {
			result.VersionUpdated = append(result.VersionUpdated, ipo)
		}
	}

	return result
}
