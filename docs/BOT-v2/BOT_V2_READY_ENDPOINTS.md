# BOT-v2 Ready Endpoints (BEI & MATS)

Dokumen ini mendefinisikan seluruh endpoint resmi di sisi **BEI (Bursa Efek Indonesia)** dan **MATS (Matching Engine)** yang telah siap dan diizinkan untuk diakses langsung oleh **BOT-v2** (Go Service). 

> [!WARNING]
> **ATURAN PENGGUNAAN ENDPOINT:**
> 1. BOT-v2 **hanya diizinkan** memanggil endpoint-endpoint yang terdaftar di dalam dokumen ini.
> 2. BOT-v2 **dilarang keras** mengirimkan order langsung (direct order) ke MATS melalui REST API. Seluruh order (Beli, Jual, Batal) **wajib** dialirkan melalui gateway Sekuritas Backend (API Sekuritas akan didokumentasikan terpisah).
> 3. Autentikasi internal BEI menggunakan header `x-service-token`.

---

## 1. BEI Service (REST API)

* **Base URL (Development):** `http://localhost:4100`
* **Header Wajib:** `x-service-token: <token-layanan-bot>`
  * *Token Lokal Standalone:* `local-bot-service-token-2026-change-me`
  * *Token Development Bat-file:* `dev-bot-service-token-change-me-2026`

### A. Endpoint Baca (GET /bot/...)
Digunakan oleh BOT-v2 untuk sinkronisasi state data referensi bursa secara berkala.

| # | Endpoint Path | Deskripsi | Parameter Response Utama |
|---|---|---|---|
| 1 | `GET /bot/daftar-saham-aktif` | Mengambil seluruh saham terdaftar beserta notasi khusus yang aktif. | `symbol`, `board`, `status = 'listed'`, `active_notations` |
| 2 | `GET /bot/trading-rules` | Mengambil seluruh aturan perdagangan aktif (lot size, tick size, price band, auto-rejection). | `lot_size_rules`, `tick_size_rules`, `price_band_rules`, `auto_rejection_rules` |
| 3 | `GET /bot/fee-schedule` | Mengambil jadwal fee & pajak transaksi terupdate. | `broker_buy_rate`, `broker_sell_rate`, `exchange_fee_rate`, `vat_rate` |
| 4 | `GET /bot/session-state` | Mengambil info sesi pasar yang sedang berjalan saat ini (kembali `null` jika pasar tutup). | `status` (pre_open, continuous, etc), `segments` |
| 5 | `GET /bot/ipo-lifecycle` | Mengambil snapshot IPO publik yang versioned. Draft tidak dikembalikan. Response berbentuk `{ items, as_of }`. | `id`, `version`, `issuer_code`, `symbol`, `company_name`, `status`, `offered_shares`, `offering_price_idr`, `subscription_lot_size`, window lifecycle, `ipo_hype_score`, `ipo_archetype`, sentiment, initial fair value |
| 6 | `GET /bot/corporate-action-minimal` | Mengambil aksi korporasi yang sedang berjalan (dividend, stock split, rights issue). | `type`, `ratio_numerator`, `ratio_denominator`, `cash_amount_per_share` |
| 7 | `GET /bot/news-module` | Mengambil pengumuman emiten (news/announcement) terpublikasi (limit 100). | `title`, `body`, `sentiment`, `intensity`, `published_at` |
| 8 | `GET /bot/fair-value-module` | Mengambil estimasi harga wajar (fair value) terbaru per saham dari bursa (kembali `[]` jika kosong). | `symbol`, `fair_value`, `confidence` |
| 9 | `GET /bot/market-regime` | Mengambil kondisi/regime pasar terkini (fallback ke regime `neutral` jika kosong). | `global_regime`, `sector_regimes` (JSON), `volatility_regime` |
| 10| `GET /bot/liquidity-profile` | Mengambil profil likuiditas dan volatilitas per saham sebagai konteks keputusan trading bot. | `symbol`, `liquidity_level`, `volatility_level`, `retail_interest` |

### B. Endpoint Admin / Input Manual (POST /bot/admin/...)
Hanya diizinkan diakses menggunakan token Admin (`local-admin-service-token-2026-change-me` / `dev-admin-service-token-change-me-2026`).

* **`POST /bot/admin/fair-value`**
  * **Fungsi:** Mengubah/mengupdate harga wajar (fair value) per saham.
  * **Payload Body:**
    ```json
    {
      "symbol": "MNDL",
      "fairValue": 1250,
      "confidence": "medium",
      "method": "admin_estimate",
      "notes": "Penyesuaian wajar MVP",
      "visibleToPlayer": true,
      "visibleToBot": true
    }
    ```
* **`POST /bot/admin/market-regime`**
  * **Fungsi:** Mengubah kondisi sentimen pasar secara global maupun sektoral.
  * **Payload Body:**
    ```json
    {
      "globalRegime": "strong_positive",
      "sectorRegimes": {
        "finance": "mild_positive",
        "technology": "strong_positive"
      },
      "volatilityRegime": "normal"
    }
    ```

---

## 2. MATS Service (WebSocket API)

* **WebSocket URL (Development):** `ws://localhost:8082/v1/market-data/ws`
* **Query Parameter:** `symbols=<simbol_saham_dipisah_koma>`
  * *Contoh:* `ws://localhost:8082/v1/market-data/ws?symbols=MNDL,NUSA,BARA`
* **Autentikasi:** Bebas (koneksi internal).

BOT-v2 menembak WebSocket MATS secara langsung untuk memperoleh aliran data pasar real-time. Setiap kali terkoneksi, MATS akan otomatis mengirimkan snapshot awal, lalu mengirimkan pembaruan (*updates*) secara real-time.

### Event JSON Payload yang Diterima BOT:

* **`session_state`** (Dikirim saat inisiasi sesi)
  ```json
  {
    "type": "session_state",
    "occurred_at": "2026-07-04T00:00:00Z",
    "payload": {
      "status": "continuous"
    }
  }
  ```
* **`depth_snapshot`** (Orderbook lengkap, dikirim saat pertama kali terhubung dan saat update berkala)
  ```json
  {
    "type": "depth_snapshot",
    "symbol": "MNDL",
    "occurred_at": "2026-07-04T00:00:01Z",
    "payload": {
      "bids": [{"price": "316", "quantity": "1500"}],
      "asks": [{"price": "320", "quantity": "800"}]
    }
  }
  ```
* **`last_price`** (Update harga perdagangan terakhir)
  ```json
  {
    "type": "last_price",
    "symbol": "MNDL",
    "occurred_at": "2026-07-04T00:00:02Z",
    "payload": {
      "symbol": "MNDL",
      "last": "318"
    }
  }
  ```
* **`market_summary`** (Rangkuman volume, harga high/low, IEP/IEV)
  ```json
  {
    "type": "market_summary",
    "symbol": "MNDL",
    "occurred_at": "2026-07-04T00:00:02Z",
    "payload": {
      "symbol": "MNDL",
      "open": "320",
      "high": "325",
      "low": "315",
      "close": "318",
      "volume": "12000",
      "value": "3816000"
    }
  }
  ```
* **`heartbeat`** (Ping berkala setiap 15 detik untuk menjaga koneksi tetap hidup)
  ```json
  {
    "type": "heartbeat",
    "occurred_at": "2026-07-04T00:00:15Z",
    "payload": {
      "status": "ok"
    }
  }
  ```
* **`session_timer`** memperbarui status dan sisa waktu segment setiap detik.
* **`best_bid_ask`** memperbarui harga bid/ask terbaik setelah order book berubah.
* **`order_status`**, **`auction_order_status`**, **`trade_tape`**, dan **`iep_iev`**
  adalah event pasar valid. BOT boleh mengabaikannya jika strategi aktif belum
  membutuhkan payload tersebut, tetapi event tidak boleh dicatat sebagai event tidak dikenal.

---

## 3. Sekuritas Service (REST & WebSocket API)

* **Base URL (Development):** `http://localhost:3002`

### A. Endpoint Internal / Admin (x-service-token)
Digunakan oleh orkestrator BOT untuk mempersiapkan state awal bot.
* **Header Wajib:** `x-service-token: <token-layanan-bot-sekuritas>`
  * *Token Lokal/Development:* `dev-bot-service-token-change-me-2026` / `local-bot-service-token-sekuritas-2026-change-me`

| Method | Path | Deskripsi | Parameter Payload Utama |
|---|---|---|---|
| `POST` | `/bot/internal/provision` | Pendaftaran massal akun BOT (tanpa verifikasi email manual). Idempotent. | `bots: [{ external_bot_id, email, tier, strategy }]` |
| `POST` | `/bot/internal/tokens` | Meminta JWT Token operasional untuk list `account_ids` bot. | `account_ids: ["<uuid>"]` |
| `POST` | `/bot/internal/genesis` | Seeding dana cash (Rupiah) & kepemilikan saham awal untuk bot. | `genesis_run_id`, `accounts: [{ external_bot_id, account_id, cash_idr, positions: [{ symbol, quantity_shares, average_price_idr }] }]` |
| `POST` | `/bot/internal/portfolio-snapshot` | Mengambil data cash balance, portfolio saham, dan status open orders milik bot secara massal. | `account_ids: ["<uuid>"]`, `include_open_orders` (bool) |
| `GET` | `/bot/internal/events/ws` | WebSocket stream untuk mendengarkan perubahan saldo & fill order milik bot secara real-time. | Query parameter: `after_sequence=<number>` |

### B. Endpoint Operasional BOT (JWT Token)
Digunakan oleh masing-masing BOT Instance untuk melakukan aktivitas trading di pasar.
* **Header Wajib:** `Authorization: Bearer <bot_jwt_token>` (dihasilkan dari endpoint `/bot/internal/tokens`)

| Method | Path | Deskripsi | Parameter Payload / Query |
|---|---|---|---|
| `POST` | `/bot/orders` | Mengirim order Beli/Jual Baru ke pasar (melalui validasi Sekuritas & diteruskan ke MATS). | `symbol`, `side` ("buy"/"sell"), `order_type` ("limit"/"market"), `price`, `quantity`, `client_order_id` (wajib format `bot:<id>:<uuid>:<seq>`) |
| `DELETE` | `/bot/orders/:id` | Membatalkan (*Cancel*) order aktif berdasarkan order ID Sekuritas. | Path Parameter: `id` (Order ID Sekuritas) |
| `PATCH` | `/bot/orders/:id` | Mengubah (*Amend*) harga atau jumlah quantity order aktif. | Path Parameter: `id`, Body: `price` (optional), `quantity` (optional) |
| `GET` | `/bot/orders/by-client-id/:clientOrderId` | Mencari data order berdasarkan `client_order_id` unik milik bot. | Path Parameter: `clientOrderId` (URL-encoded) |

### C. Endpoint IPO BOT (JWT Token)
* **Header Wajib:** `Authorization: Bearer <bot_jwt_token>`

| Method | Path | Deskripsi | Parameter Payload |
|---|---|---|---|
| `POST` | `/bot/ipo/:id/subscribe` | Melakukan pemesanan (*subscription*) IPO emiten baru sebelum listing. | Path Parameter: `id` (IPO Event ID), Body: `requested_shares` |
| `POST` | `/bot/ipo/:id/subscriptions/:subscriptionId/cancel` | Membatalkan pemesanan IPO yang masih aktif (dalam masa bookbuilding/subscription). | Path Parameter: `id`, `subscriptionId` |
| `GET` | `/bot/ipo/subscriptions` | Recovery snapshot seluruh subscription IPO milik BOT. | Response: `items[]` berisi reserve, allocation, debit, status, dan event version |
| `GET` | `/bot/ipo/subscriptions/:subscriptionId` | Lookup subscription setelah timeout/unknown outcome. | Path Parameter: `subscriptionId` |

Semua mutation IPO mewajibkan `Idempotency-Key`. Response `202` dengan status
`cash_reserved` berarti reserve sudah tersimpan dan forward ke BEI sedang
diretry; BOT wajib lookup menggunakan subscription/key yang sama dan tidak
membuat subscription baru.
