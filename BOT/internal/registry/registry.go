package registry

import (
	"sync"

	"github.com/Mandala-Exchange/bot-v2/internal/portfolio"
)

type PositionEntry struct {
	Symbol          string
	AvailableShares int64
	ReservedShares  int64
	PendingShares   int64
	AveragePriceIDR int64
}

// IPOSubscriptionState menyimpan state subscription IPO satu bot untuk satu IPO event.
type IPOSubscriptionState struct {
	SubscriptionID  string
	Status          string
	IdempotencyKey  string
	DecisionVersion int
	RequestedShares int64
	ReservedCashIDR string
}

// IsActive mengembalikan true jika subscription masih dalam status non-final.
func (s IPOSubscriptionState) IsActive() bool {
	switch s.Status {
	case "cash_reserved", "submitted_to_bei", "allocated":
		return true
	}
	return false
}

type BotInstance struct {
	mu sync.RWMutex

	ExternalBotID string
	AccountID     string
	Strategy      string
	Status        string // "active", "distressed", "bankrupt", "paused"

	// Portfolio Cache
	CashIDR         int64
	ReservedCashIDR int64
	PendingCashIDR  int64
	Positions       map[string]PositionEntry
	OpenOrderIDs    map[string]string // client_order_id -> sekuritas_order_id

	// Session Level Rate Limit Guardrails
	OrdersThisSession  int
	LastSessionID      string
	ActivitySessionID  string
	InactiveForSession bool

	// News Tracking
	ProcessedNewsIDs map[string]struct{}

	// IPO Subscription State
	// Key: ipo_event_id. State ini diisi saat startup recovery dan diperbarui setelah setiap eksekusi.
	IPOSubscriptions map[string]IPOSubscriptionState
}

func (b *BotInstance) IsInactiveForSession(sessionID string, inactiveRate, roll float64) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.ActivitySessionID != sessionID {
		b.ActivitySessionID = sessionID
		b.InactiveForSession = roll < inactiveRate
	}
	return b.InactiveForSession
}

func NewBotInstance(botID, accountID, strategy string) *BotInstance {
	return &BotInstance{
		ExternalBotID:    botID,
		AccountID:        accountID,
		Strategy:         strategy,
		Status:           "active",
		Positions:        make(map[string]PositionEntry),
		OpenOrderIDs:     make(map[string]string),
		ProcessedNewsIDs: make(map[string]struct{}),
		IPOSubscriptions: make(map[string]IPOSubscriptionState),
	}
}

func (b *BotInstance) GetStatus() string {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.Status
}

func (b *BotInstance) SetStatus(status string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.Status = status
}

func (b *BotInstance) GetCash() (available, reserved, pending int64) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.CashIDR, b.ReservedCashIDR, b.PendingCashIDR
}

func (b *BotInstance) GetPosition(symbol string) PositionEntry {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.Positions[symbol]
}

func (b *BotInstance) AddOrderCount(sessionID string) int {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.LastSessionID != sessionID {
		b.LastSessionID = sessionID
		b.OrdersThisSession = 0
	}
	b.OrdersThisSession++
	return b.OrdersThisSession
}

func (b *BotInstance) GetOrdersThisSession(sessionID string) int {
	b.mu.RLock()
	defer b.mu.RUnlock()
	if b.LastSessionID != sessionID {
		return 0
	}
	return b.OrdersThisSession
}

// HasAnyPosition mengembalikan true jika bot masih punya saham (available, reserved, atau pending).
func (b *BotInstance) HasAnyPosition() bool {
	b.mu.RLock()
	defer b.mu.RUnlock()
	for _, pos := range b.Positions {
		if pos.AvailableShares > 0 || pos.ReservedShares > 0 || pos.PendingShares > 0 {
			return true
		}
	}
	return false
}

// HasOpenOrders mengembalikan true jika bot masih punya open order yang tercatat.
func (b *BotInstance) HasOpenOrders() bool {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return len(b.OpenOrderIDs) > 0
}

// SetOpenOrderID menambahkan atau mengupdate mapping client order ID ke sekuritas order ID.
func (b *BotInstance) SetOpenOrderID(clientOrderID, orderID string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.OpenOrderIDs[clientOrderID] = orderID
}

// DeleteOpenOrderID menghapus order dari tracking (saat order terminal: filled/cancelled/rejected/expired).
func (b *BotInstance) DeleteOpenOrderID(clientOrderID string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.OpenOrderIDs, clientOrderID)
}

// UpdateFromSnapshot applies the authoritative cash, position & IPO subscription state from Sekuritas
func (b *BotInstance) UpdateFromSnapshot(acc portfolio.Account) {
	b.mu.Lock()
	defer b.mu.Unlock()

	b.CashIDR = acc.Cash.AvailableIDR
	b.ReservedCashIDR = acc.Cash.ReservedIDR
	b.PendingCashIDR = acc.Cash.PendingIDR

	b.Positions = make(map[string]PositionEntry)
	for _, pos := range acc.Positions {
		b.Positions[pos.Symbol] = PositionEntry{
			Symbol:          pos.Symbol,
			AvailableShares: pos.AvailableShares,
			ReservedShares:  pos.ReservedShares,
			PendingShares:   pos.PendingShares,
			AveragePriceIDR: pos.AveragePriceIDR,
		}
	}

	b.OpenOrderIDs = make(map[string]string)
	for _, ord := range acc.OpenOrders {
		b.OpenOrderIDs[ord.ClientOrderID] = ord.OrderID
	}

	// Populate IPO subscription state dari snapshot Sekuritas.
	// Hanya overwrite entry yang ada di snapshot; entry yang tidak ada di snapshot
	// (mis. baru dibuat oleh executor) dibiarkan apa adanya untuk menghindari race.
	for _, sub := range acc.IPOSubscriptions {
		if sub.IsActive() {
			b.IPOSubscriptions[sub.IPOEventID] = IPOSubscriptionState{
				SubscriptionID:  sub.SubscriptionID,
				Status:          sub.Status,
				IdempotencyKey:  sub.IdempotencyKey,
				RequestedShares: sub.RequestedShares,
				ReservedCashIDR: sub.ReservedCashIDR,
			}
		} else {
			// Subscription sudah terminal — hapus dari in-memory state agar tidak diblokir ulang
			delete(b.IPOSubscriptions, sub.IPOEventID)
		}
	}
}

// SetIPOSubscription menyimpan atau mengupdate state subscription IPO untuk satu event.
func (b *BotInstance) SetIPOSubscription(ipoEventID string, state IPOSubscriptionState) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.IPOSubscriptions[ipoEventID] = state
}

// GetIPOSubscription mengambil state subscription IPO untuk satu event.
func (b *BotInstance) GetIPOSubscription(ipoEventID string) (IPOSubscriptionState, bool) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	s, ok := b.IPOSubscriptions[ipoEventID]
	return s, ok
}

// HasActiveIPOSubscription mengembalikan true jika bot sudah punya subscription aktif untuk IPO ini.
func (b *BotInstance) HasActiveIPOSubscription(ipoEventID string) bool {
	b.mu.RLock()
	defer b.mu.RUnlock()
	s, ok := b.IPOSubscriptions[ipoEventID]
	return ok && s.IsActive()
}

// RemoveIPOSubscription menghapus state subscription IPO (mis. setelah IPO cancelled).
func (b *BotInstance) RemoveIPOSubscription(ipoEventID string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.IPOSubscriptions, ipoEventID)
}

// GetAllIPOSubscriptions mengembalikan snapshot dari semua IPO subscription state bot ini.
func (b *BotInstance) GetAllIPOSubscriptions() map[string]IPOSubscriptionState {
	b.mu.RLock()
	defer b.mu.RUnlock()
	copy := make(map[string]IPOSubscriptionState, len(b.IPOSubscriptions))
	for k, v := range b.IPOSubscriptions {
		copy[k] = v
	}
	return copy
}

type Registry struct {
	mu   sync.RWMutex
	bots map[string]*BotInstance // accountID -> BotInstance
}

func NewRegistry() *Registry {
	return &Registry{
		bots: make(map[string]*BotInstance),
	}
}

func (r *Registry) Register(botID, accountID, strategy string) *BotInstance {
	r.mu.Lock()
	defer r.mu.Unlock()

	bot := NewBotInstance(botID, accountID, strategy)
	r.bots[accountID] = bot
	return bot
}

func (r *Registry) GetBot(accountID string) (*BotInstance, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	bot, ok := r.bots[accountID]
	return bot, ok
}

func (r *Registry) ListBots() []*BotInstance {
	r.mu.RLock()
	defer r.mu.RUnlock()

	list := make([]*BotInstance, 0, len(r.bots))
	for _, b := range r.bots {
		list = append(list, b)
	}
	return list
}

func (b *BotInstance) HasProcessedNews(newsID string) bool {
	b.mu.RLock()
	defer b.mu.RUnlock()
	_, ok := b.ProcessedNewsIDs[newsID]
	return ok
}

func (b *BotInstance) MarkNewsProcessed(newsID string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.ProcessedNewsIDs[newsID] = struct{}{}
}

func (b *BotInstance) ClearProcessedNews() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.ProcessedNewsIDs = make(map[string]struct{})
}

func (b *BotInstance) DeleteOpenOrderBySekuritasID(orderID string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for clientID, targetID := range b.OpenOrderIDs {
		if targetID == orderID {
			delete(b.OpenOrderIDs, clientID)
			break
		}
	}
}

func (b *BotInstance) GetAndClearOpenOrderIDs() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	ids := make([]string, 0, len(b.OpenOrderIDs))
	for clientID, orderID := range b.OpenOrderIDs {
		ids = append(ids, orderID)
		delete(b.OpenOrderIDs, clientID)
	}
	return ids
}

