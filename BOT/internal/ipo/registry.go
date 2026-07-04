package ipo

import (
	"sync"
	"time"

	bei "github.com/Mandala-Exchange/bot-v2/internal/client/bei"
)

// IPOEntry menyimpan state satu IPO event yang diketahui BOT.
type IPOEntry struct {
	Lifecycle        bei.IPOLifecycle
	ProcessedVersion int      // versi IPO terakhir yang sudah dievaluasi dan diproses
	LastTransition   time.Time
	StatusHistory    []string // ringkasan: ["bookbuilding","subscription","allocation"]
	AttentionExpiry  time.Time // untuk attention boost pasca-listing (Fase 5F)
}

// IPORegistry adalah registry thread-safe untuk semua IPO yang diketahui BOT.
type IPORegistry struct {
	mu      sync.RWMutex
	entries map[string]*IPOEntry // key: ipo_event_id
}

// NewIPORegistry membuat instance IPORegistry baru.
func NewIPORegistry() *IPORegistry {
	return &IPORegistry{
		entries: make(map[string]*IPOEntry),
	}
}

// Upsert menyimpan atau mengupdate satu IPO event. Mengembalikan (isNew, versionChanged).
func (r *IPORegistry) Upsert(lifecycle bei.IPOLifecycle) (isNew bool, versionChanged bool) {
	r.mu.Lock()
	defer r.mu.Unlock()

	existing, ok := r.entries[lifecycle.ID]
	if !ok {
		// Entry baru
		r.entries[lifecycle.ID] = &IPOEntry{
			Lifecycle:        lifecycle,
			ProcessedVersion: -1, // belum pernah diproses
			LastTransition:   time.Now(),
			StatusHistory:    []string{lifecycle.Status},
		}
		return true, false
	}

	vChanged := existing.Lifecycle.Version < lifecycle.Version
	if vChanged {
		// Catat transisi status jika berubah
		if existing.Lifecycle.Status != lifecycle.Status {
			existing.StatusHistory = append(existing.StatusHistory, lifecycle.Status)
			existing.LastTransition = time.Now()
		}
		existing.Lifecycle = lifecycle
	}
	return false, vChanged
}

// Get mengambil satu IPO entry berdasarkan ID.
func (r *IPORegistry) Get(ipoEventID string) (*IPOEntry, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	e, ok := r.entries[ipoEventID]
	return e, ok
}

// All mengembalikan snapshot dari semua IPO entry.
func (r *IPORegistry) All() []IPOEntry {
	r.mu.RLock()
	defer r.mu.RUnlock()
	result := make([]IPOEntry, 0, len(r.entries))
	for _, e := range r.entries {
		result = append(result, *e)
	}
	return result
}

// MarkProcessed menandai bahwa versi tertentu dari sebuah IPO sudah diproses.
func (r *IPORegistry) MarkProcessed(ipoEventID string, version int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if e, ok := r.entries[ipoEventID]; ok {
		e.ProcessedVersion = version
	}
}

// Remove menghapus satu IPO entry dari registry (mis. setelah cancelled + retention window).
func (r *IPORegistry) Remove(ipoEventID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.entries, ipoEventID)
}

// SetAttentionExpiry menyetel expiry untuk attention boost pasca-listing.
func (r *IPORegistry) SetAttentionExpiry(ipoEventID string, expiry time.Time) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if e, ok := r.entries[ipoEventID]; ok {
		e.AttentionExpiry = expiry
	}
}
