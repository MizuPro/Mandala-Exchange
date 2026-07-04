// Package memory menyediakan session memory sederhana untuk BOT-v2 Fase 3.
// Memory ini menyimpan statistik per-bot per-sesi untuk keperluan debugging
// dan audit order behavior.
//
// Fase 4 akan mengembangkan ini menjadi memory lintas sesi penuh (short/medium/long)
// sesuai spesifikasi BOT_V2_CONCEPT.md Section 10.
package memory

import (
	"sync"
	"time"
)

// BotSessionMemory menyimpan statistik bot untuk satu sesi perdagangan.
// Disimpan in-memory dan di-reset setiap sesi baru.
type BotSessionMemory struct {
	mu sync.Mutex

	BotID          string
	SessionDate    string // format "2006-01-02", dipakai sebagai session key
	OrdersPlaced   int
	OrdersFilled   int
	OrdersRejected int
	OrdersCancelled int
	LastUpdatedAt  time.Time
}

// Manager mengelola memory untuk semua bot.
type Manager struct {
	mu      sync.RWMutex
	sessions map[string]*BotSessionMemory // botID -> memory
}

// NewManager membuat Manager baru.
func NewManager() *Manager {
	return &Manager{
		sessions: make(map[string]*BotSessionMemory),
	}
}

// GetOrCreate mengembalikan session memory untuk bot, membuat baru jika belum ada.
// Session di-reset otomatis jika hari berganti.
func (m *Manager) GetOrCreate(botID string) *BotSessionMemory {
	today := time.Now().Format("2006-01-02")

	m.mu.RLock()
	mem, exists := m.sessions[botID]
	m.mu.RUnlock()

	if exists && mem.SessionDate == today {
		return mem
	}

	// Buat session baru (hari baru atau pertama kali)
	m.mu.Lock()
	defer m.mu.Unlock()

	// Re-check setelah acquire write lock (double-checked locking)
	if mem, exists = m.sessions[botID]; exists && mem.SessionDate == today {
		return mem
	}

	newMem := &BotSessionMemory{
		BotID:       botID,
		SessionDate: today,
	}
	m.sessions[botID] = newMem
	return newMem
}

// RecordOrderPlaced mencatat bahwa bot menempatkan order.
func (m *Manager) RecordOrderPlaced(botID string) {
	mem := m.GetOrCreate(botID)
	mem.mu.Lock()
	defer mem.mu.Unlock()
	mem.OrdersPlaced++
	mem.LastUpdatedAt = time.Now()
}

// RecordOrderFilled mencatat bahwa order bot terisi (matched).
func (m *Manager) RecordOrderFilled(botID string) {
	mem := m.GetOrCreate(botID)
	mem.mu.Lock()
	defer mem.mu.Unlock()
	mem.OrdersFilled++
	mem.LastUpdatedAt = time.Now()
}

// RecordOrderRejected mencatat bahwa order bot ditolak.
func (m *Manager) RecordOrderRejected(botID string) {
	mem := m.GetOrCreate(botID)
	mem.mu.Lock()
	defer mem.mu.Unlock()
	mem.OrdersRejected++
	mem.LastUpdatedAt = time.Now()
}

// RecordOrderCancelled mencatat bahwa order bot dibatalkan.
func (m *Manager) RecordOrderCancelled(botID string) {
	mem := m.GetOrCreate(botID)
	mem.mu.Lock()
	defer mem.mu.Unlock()
	mem.OrdersCancelled++
	mem.LastUpdatedAt = time.Now()
}

// BotSessionSummary adalah snapshot aman (tanpa mutex) untuk ditampilkan/dilaporkan.
type BotSessionSummary struct {
	BotID           string
	SessionDate     string
	OrdersPlaced    int
	OrdersFilled    int
	OrdersRejected  int
	OrdersCancelled int
	LastUpdatedAt   time.Time
}

// Summary mengembalikan ringkasan semua sesi bot saat ini.
// Mengembalikan BotSessionSummary (tanpa mutex) agar aman untuk diprint/dikirim.
func (m *Manager) Summary() []BotSessionSummary {
	m.mu.RLock()
	defer m.mu.RUnlock()

	result := make([]BotSessionSummary, 0, len(m.sessions))
	for _, mem := range m.sessions {
		mem.mu.Lock()
		snapshot := BotSessionSummary{
			BotID:           mem.BotID,
			SessionDate:     mem.SessionDate,
			OrdersPlaced:    mem.OrdersPlaced,
			OrdersFilled:    mem.OrdersFilled,
			OrdersRejected:  mem.OrdersRejected,
			OrdersCancelled: mem.OrdersCancelled,
			LastUpdatedAt:   mem.LastUpdatedAt,
		}
		mem.mu.Unlock()
		result = append(result, snapshot)
	}
	return result
}
