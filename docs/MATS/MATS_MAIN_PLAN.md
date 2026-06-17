# Main Implementation Plan - MATS Service

## Fase 1: Kontrak Engine & API
- **Status**: [x] Selesai
- **Tugas**:
  - [x] Task 1.1: Definisikan domain order, order amendment, order book, trade, session, market data, auction, price band, ARA/ARB, non-cancellation period, dan order expiry.
  - [x] Task 1.2: Definisikan REST API untuk place order, amend order, cancel order, order status, health, dan admin control.
  - [x] Task 1.3: Definisikan WebSocket event untuk market data, session state, IEP, IEV, trade tape, market halt, special notation, dan market summary.
  - [x] Task 1.4: Definisikan payload trade event ke BEI dan order status event ke Sekuritas.
- **Catatan**: Contract harus stabil sebelum engine dibuat.

## Fase 2: Inisialisasi Service & Persistence
- **Status**: [x] Selesai
- **Tugas**:
  - [x] Task 2.1: Buat struktur project MATS dengan Go.
  - [x] Task 2.2: Pilih HTTP/router ringan dan WebSocket library yang stabil untuk REST API dan market data.
  - [x] Task 2.3: Konfigurasi PostgreSQL via Docker Compose untuk event/order/trade persistence.
  - [x] Task 2.4: Konfigurasi driver PostgreSQL Go, disarankan `pgx`.
  - [x] Task 2.5: Buat health check, environment config, logging, dan service authentication.
  - [x] Task 2.6: Siapkan sequence generator untuk order dan trade.
  - [x] Task 2.7: Siapkan struktur in-memory order book dan recovery dari event log.
- **Catatan**: Sequence number penting untuk determinisme dan audit.

## Fase 3: Sync Instrumen & Rules dari BEI
- **Status**: [x] Selesai
- **Tugas**:
  - [x] Task 3.1: Implement client untuk mengambil listed securities dari BEI.
  - [x] Task 3.2: Implement client untuk mengambil tick size/fraksi harga, lot size, ARA/ARB, price band, auto rejection volume, board rule, special notation, non-cancellation period, post-closing rule, fee-independent trading rule, dan session config.
  - [x] Task 3.3: Cache rules lokal dengan refresh manual/periodik.
  - [x] Task 3.4: Tambahkan validasi symbol active/suspended/trading halt berdasarkan data BEI.
- **Catatan**: BEI tetap sumber aturan final.

## Fase 4: Order Gateway & Validasi
- **Status**: [x] Selesai
- **Tugas**:
  - [x] Task 4.1: Implement endpoint place limit order.
  - [x] Task 4.2: Implement endpoint amend order.
  - [x] Task 4.3: Implement endpoint cancel order.
  - [x] Task 4.4: Implement idempotency untuk place/amend/cancel order.
  - [x] Task 4.5: Implement validasi market open, symbol status, special notation, tick size/fraksi harga, lot size, ARA/ARB, price band berbasis reference price, auto rejection volume, dan quantity.
  - [x] Task 4.6: Reject amend/cancel saat order berada dalam non-cancellation period.
  - [x] Task 4.7: Reject short selling dan margin flag pada MVP jika request payload mencoba menggunakannya.
  - [x] Task 4.8: Kembalikan reject reason yang eksplisit ke Sekuritas.
- **Catatan**: Validasi saldo/saham bukan tanggung jawab MATS.

## Fase 5: Order Book & Continuous Matching
- **Status**: [x] Selesai
- **Tugas**:
  - [x] Task 5.1: Implement order book per symbol dengan price-time priority.
  - [x] Task 5.2: Implement matching buy vs sell untuk continuous market.
  - [x] Task 5.3: Dukung partial fill, full fill, remaining quantity, amend open order, dan cancel remaining order.
  - [x] Task 5.4: Generate trade event setiap match.
  - [x] Task 5.5: Generate market summary dasar: open, high, low, close, last, volume, value, dan frequency.
  - [x] Task 5.6: Tambahkan unit test untuk skenario matching dasar dan edge case.
- **Catatan**: Ini inti MATS dan harus diuji ketat.

## Fase 6: Order Status & Trade Event Delivery
- **Status**: [x] Selesai
- **Tugas**:
  - [x] Task 6.1: Implement status order accepted, rejected, open, amended, partially_filled, filled, cancelled, expired, dan locked_non_cancellable.
  - [x] Task 6.2: Implement delivery order status ke Sekuritas.
  - [x] Task 6.3: Implement delivery trade final ke BEI.
  - [x] Task 6.4: Tambahkan retry dan dead-letter sederhana untuk event gagal kirim.
  - [x] Task 6.5: Tambahkan correlation id untuk tracing antar-service.
- **Catatan**: Event delivery harus idempotent.

## Fase 7: WebSocket Market Data
- **Status**: [x] Selesai
- **Tugas**:
  - [x] Task 7.1: Implement WebSocket endpoint untuk subscribe symbol.
  - [x] Task 7.2: Publish best bid/ask, full depth snapshot, last price, trade tape, session state, special notation, halt status, dan market summary.
  - [x] Task 7.3: Tambahkan snapshot-on-connect agar client bisa recover.
  - [x] Task 7.4: Tambahkan heartbeat dan reconnect guidance.
  - [x] Task 7.5: Uji frontend Sekuritas dapat membaca feed publik.
- **Catatan**: Order tetap tidak boleh dikirim via WebSocket publik.

## Fase 8: Auction, IEP & IEV
- **Status**: [x] Selesai
- **Tugas**:
  - [x] Task 8.1: Implement opening auction order collection.
  - [x] Task 8.2: Implement closing auction order collection.
  - [x] Task 8.3: Implement kalkulasi IEP dan IEV.
  - [x] Task 8.4: Implement auction uncrossing untuk menghasilkan trade saat auction selesai.
  - [x] Task 8.5: Implement non-cancellation period pada pre-opening/pre-closing.
  - [x] Task 8.6: Implement random closing sederhana sesuai konfigurasi BEI.
  - [x] Task 8.7: Publish IEP/IEV realtime ke market data WebSocket.
- **Catatan**: Algoritma auction awal boleh simplified tetapi harus terdokumentasi.

## Fase 9: Session Engine & Admin Control
- **Status**: [x] Selesai
- **Tugas**:
  - [x] Task 9.1: Implement state machine sesi: CLOSED, PRE_OPEN, OPENING_AUCTION, CONTINUOUS, PRE_CLOSE, RANDOM_CLOSING, CLOSING_AUCTION, POST_CLOSE, NON_CANCELLATION, HALTED.
  - [x] Task 9.2: Implement start/stop/manual override session.
  - [x] Task 9.3: Implement expire semua open order pada akhir sesi.
  - [x] Task 9.4: Implement market-wide trading halt, resume, symbol suspend, dan symbol resume.
  - [x] Task 9.5: Implement post-closing sederhana pada closing price jika diaktifkan BEI.
  - [x] Task 9.6: Publish session transition, halt/resume event, locked order event, dan expired order event ke Sekuritas dan market data.
- **Catatan**: Durasi sesi mengikuti konfigurasi admin dari BEI.

## Fase 10: Integration Test & Deployment
- **Status**: [x] Selesai
- **Tugas**:
  - [x] Task 10.1: Buat integration test flow Sekuritas -> MATS -> BEI.
  - [x] Task 10.2: Test matching player vs player, player vs bot account, partial fill, amend, cancel, expiry, dan reject.
  - [x] Task 10.3: Test ARA/ARB, tick size, auto rejection volume, non-cancellation period, market halt, dan symbol suspend.
  - [x] Task 10.4: Test WebSocket full depth market data dan market summary selama sesi 5-10 menit.
  - [x] Task 10.5: Siapkan konfigurasi Cloudflare Tunnel untuk MATS.
  - [x] Task 10.6: Tambahkan runbook debugging order/trade.
- **Catatan**: Fokus pada traceability saat bug terjadi.

## [V2 / Post-MVP] Status Pelaksanaan

- **Integrasi Admin UI & Session Runner**: Selesai.
- **Redis Pub/Sub Subscription**: Selesai.
