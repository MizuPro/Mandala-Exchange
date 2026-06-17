# MATS Architecture V2 (Automated Matching & Event-Driven)

Dokumen ini menjelaskan pembaruan arsitektur MATS untuk otomatisasi bursa dan standar API terpusat.

## 1. OpenAPI & Shared Contracts
Struktur inti MATS yang sebelumnya hanya didefinisikan di `types.go` kini memiliki representasi spesifikasi terpusat di `Mandala-Exchange/openapi.yaml`. Perubahan di sisi MATS harus selalu disinkronkan dengan file YAML tersebut agar BEI dan SEKURITAS dapat men-*generate* *type definition* yang cocok.

## 2. Penghapusan Polling (Redis Pub/Sub)
Sistem sinkronisasi aturan (via `syncRulesPeriodically`) telah digantikan:
MATS berjalan sebagai *Redis Subscriber* pada channel `market_updates`. Seluruh modifikasi *trading rules*, *securities*, dan *session states* dari otoritas bursa (BEI) akan diterima MATS secara langsung (*real-time* event) dan di-load ke dalam *memory cache*.

## 3. Session Engine Automation
MATS V2 memperkenalkan *Background Session Daemon*.
- **Auto-Transition**: Daemon (berbasis *Ticker*) membaca durasi waktu per segmen dari BEI, dan secara otomatis memindahkan *state* sesi jika waktunya habis.
- **Auto-Uncross**: Saat *opening_auction* atau *closing_auction* berakhir, Daemon otomatis memanggil fungsi `UncrossAuction()` untuk mencetak harga pembukaan/penutupan.
- **Auto-Expire**: Saat sesi berganti menjadi `closed`, semua order (limit/market) hari tersebut yang berstatus `open` atau `partially_filled` akan otomatis dibatalkan via fungsi `ExpireOpenOrders()`.

## 4. Enhanced WebSocket
*Payload* WebSocket MATS yang dipancarkan ke Sekuritas kini membawa metrik tambahan:
- `total_duration_seconds`
- `time_remaining_seconds`
Agar klien dan trading bot bisa melakukan penyesuaian strategi (*cancel-on-close* atau eksekusi detik terakhir).
