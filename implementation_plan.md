# Implementation Plan - Bug Analyzer Status Pasar Frontend

Target analisis: indikator status pasar dan tombol order yang menampilkan `PASAR TUTUP` di frontend SEKURITAS.
Mode: soft.
Fokus: alur data session status dari MATS -> SEKURITAS backend WebSocket proxy -> Zustand store -> UI Market/Dashboard/MarketDetail.

request_feedback = true

---

## Ringkasan Temuan

Ditemukan bug terkonfirmasi pada cara frontend menentukan status awal market. UI menganggap `market.sessionStatus` kosong sebagai pasar tertutup. Padahal nilai kosong bukan berarti closed, melainkan status belum diterima dari WebSocket.

Runtime lokal menunjukkan:

- MATS health sudah memiliki `session_status` aktif.
- BEI active session juga aktif.
- WebSocket proxy SEKURITAS mengirim frame pertama `proxy_status`, bukan `session_state`.
- Frontend mengabaikan `proxy_status`, sehingga `market.sessionStatus` tetap kosong sampai event `session_state` atau `session_timer` masuk.

Akibatnya, pada halaman detail saham tombol order bisa menampilkan `PASAR TUTUP` walaupun sesi sebenarnya sedang `pre_open` atau `continuous`.

---

## 1. Confirmed Bug - Frontend Menganggap Status Kosong Sebagai Pasar Tutup

### Lokasi

- `SEKURITAS/frontend/src/store/useStore.ts:163`
- `SEKURITAS/frontend/src/pages/MarketDetail.tsx:497-498`
- `SEKURITAS/frontend/src/pages/MarketDetail.tsx:1502`
- `SEKURITAS/frontend/src/pages/MarketDetail.tsx:1510`
- `SEKURITAS/frontend/src/pages/Dashboard.tsx:444-463`
- `SEKURITAS/frontend/src/components/MarketPanel.tsx:342-356`

### Alur Bug

State awal market dibuat dengan `sessionStatus: ""`.

Di `MarketDetail`, status pasar dihitung dengan:

```ts
const isMarketOpen = market.sessionStatus && market.sessionStatus !== 'closed';
```

Saat `sessionStatus` masih kosong, `isMarketOpen` menjadi falsy. Tombol order kemudian:

- disabled karena `!isMarketOpen`
- menampilkan teks `PASAR TUTUP`

Masalahnya, string kosong bukan status pasar valid. Itu adalah state `unknown/loading`. UI saat ini menyamakan `unknown` dengan `closed`.

### Dampak

- User melihat `PASAR TUTUP` walaupun session backend sedang `pre_open` atau `continuous`.
- Tombol order terkunci sebelum event WebSocket session masuk.
- Jika WebSocket tidak menerima event session, UI bisa terus salah menampilkan pasar tertutup.

### Rencana Perbaikan

1. Tambahkan helper eksplisit untuk status pasar, misalnya:

```ts
const ORDER_ENTRY_SESSION_STATUSES = new Set([
  'pre_open',
  'opening_auction',
  'continuous',
  'closing_auction',
  'post_closing'
]);
```

2. Ganti logika `market.sessionStatus && market.sessionStatus !== 'closed'` dengan helper yang membedakan:

- `unknown`: status belum diterima
- `open`: status mengizinkan order entry
- `closed`: status benar-benar closed/halted/pre_close/non_cancellation/random_closing jika memang tidak boleh entry

3. Di tombol `MarketDetail`, jangan tampilkan `PASAR TUTUP` saat status masih kosong. Gunakan teks seperti `MENUNGGU STATUS PASAR` dan tetap disabled sampai status valid diterima.
4. Untuk header `Dashboard` dan `MarketPanel`, tampilkan state `SYNCING` atau `OFFLINE` saat status kosong, bukan `CLOSED`.

---

## 2. Confirmed Bug - WebSocket Proxy Tidak Cache `session_state` Untuk Client Baru

### Lokasi

- `SEKURITAS/backend/src/services/market-ws-proxy.ts:8-9`
- `SEKURITAS/backend/src/services/market-ws-proxy.ts:78-99`
- `SEKURITAS/backend/src/services/market-ws-proxy.ts:135-146`
- `MATS/internal/marketdata/ws.go:123-134`

### Alur Bug

MATS sudah benar mengirim initial snapshot:

- Saat client WebSocket baru connect ke MATS, `sendInitialSnapshots` mengirim event `session_state`.

Namun frontend tidak connect langsung ke MATS. Frontend connect ke proxy SEKURITAS.

Proxy SEKURITAS saat ini hanya menyimpan cache:

- `depthCache`
- `lastPriceCache`

Saat client browser baru connect ke proxy, proxy hanya mengirim:

- `proxy_status`
- cached depth
- cached last price

Proxy tidak mengirim cached `session_state`, karena event session tidak pernah disimpan. Jika upstream MATS sudah terbuka dari client lain, client baru tidak mendapatkan initial `session_state` dari MATS. Client harus menunggu event session berikutnya.

### Dampak

- Client baru bisa masuk dengan `sessionStatus` kosong.
- UI menampilkan fallback `CLOSED` atau `PASAR TUTUP`.
- Perilaku menjadi tidak konsisten antar tab/client, tergantung timing event WebSocket.

### Rencana Perbaikan

1. Tambahkan cache `sessionStateCache` di `market-ws-proxy.ts`.
2. Saat proxy menerima event `session_state` atau `session_timer`, simpan event terakhir yang memiliki status.
3. Saat browser client baru connect, kirim `sessionStateCache` setelah `proxy_status` dan sebelum cache depth/last price.
4. Jika cache belum ada, proxy bisa mengirim event eksplisit:

```json
{
  "type": "session_state",
  "payload": { "status": "" }
}
```

Namun lebih baik proxy mengambil snapshot dari MATS/BEI atau menunggu upstream initial event pertama, lalu broadcast ke client.

---

## 3. Potential Concern - `fetchMarketData()` Tidak Mengambil Session Status Awal

### Lokasi

- `SEKURITAS/frontend/src/store/useStore.ts:254-265`
- `SEKURITAS/backend/src/routes/market.ts:9-20`
- `BEI/src/routes/rules.ts:196-207`

### Penjelasan

Frontend initial data fetch hanya mengambil:

- `/market/securities`
- `/market/fees`

Session status hanya datang dari WebSocket. Ini bukan bug fatal jika WebSocket selalu sehat dan proxy selalu mengirim snapshot session. Namun untuk UX yang stabil, REST initial fetch sebaiknya bisa mengisi status pasar sebelum WebSocket event datang.

### Rencana Perbaikan

1. Tambahkan endpoint backend SEKURITAS, misalnya `GET /api/v1/market/session`, yang proxy ke BEI active session atau MATS health.
2. Update `fetchMarketData()` agar ikut mengambil session status awal.
3. Setelah WebSocket aktif, WebSocket tetap menjadi sumber update real-time.

---

## Verifikasi Setelah Perbaikan

1. Jalankan dev stack dengan `start-all.bat development`.
2. Buka `/market/:symbol` saat session backend `pre_open`.
3. Pastikan tombol tidak lagi menampilkan `PASAR TUTUP`; jika status sudah `pre_open`, tombol boleh menampilkan kirim order sesuai aturan entry.
4. Buka tab browser kedua saat tab pertama masih aktif. Tab kedua harus langsung menerima status session dari proxy cache.
5. Ubah session ke `continuous`, lalu pastikan header `Dashboard`, `MarketPanel`, dan tombol `MarketDetail` sinkron.
6. Putuskan WebSocket sementara. UI harus menampilkan `OFFLINE` atau `SYNCING`, bukan `PASAR TUTUP` palsu.

## Catatan Eksekusi

Plan ini bisa dieksekusi oleh Gemini 3 Flash. Scope perbaikannya kecil sampai menengah dan sebagian besar berada di frontend store/UI serta satu file WebSocket proxy backend. Model yang lebih advanced tidak wajib, kecuali ingin sekaligus menambahkan test end-to-end WebSocket lintas service.
