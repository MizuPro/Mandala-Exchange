# Log Implementasi Tahap 3 - Local Hybrid Hosting

Tanggal eksekusi: 2026-06-19
Status akhir: selesai untuk scope Tahap 3 local hybrid.

## Ringkasan

Tahap 3 mengimplementasikan Mandala Exchange dengan local hybrid hosting:

- Frontend dan Sekuritas API dibuka melalui Cloudflare Tunnel.
- MATS, BEI, Postgres, dan Redis tetap berjalan lokal/private.
- Browser publik hanya mengakses Sekuritas Backend.
- Sekuritas Backend menjadi gateway REST dan WebSocket menuju MATS.
- Backup/restore lokal tersedia untuk database Sekuritas, MATS, dan BEI.

## Audit Konsistensi

Audit dilakukan terhadap konfigurasi port, env, CORS, startup script, tunnel config, frontend endpoint resolver, dan script operasional.

| Item | Status |
|---|---|
| Sekuritas Backend `3002` | Konsisten |
| Frontend preview `4173` | Konsisten |
| Vite dev `5173` | Konsisten untuk development |
| Postgres Sekuritas `5432` | Konsisten |
| MATS `8082` | Konsisten dan tetap private |
| BEI `4100` | Konsisten dan tetap private |
| Frontend tunnel `mandala-sekuritas.michaelk.fun` | Konsisten |
| API/WS tunnel `api-mandala-sekuritas.michaelk.fun` | Konsisten |
| WebSocket publik | Melewati Sekuritas Backend, tidak langsung ke MATS |
| Playground HTML | Tidak menjadi UI publik Vite |

Tidak ditemukan mismatch port atau CORS kritis setelah validasi akhir.

## Perbaikan yang Dilakukan

### Backend dan Infrastruktur

1. `SEKURITAS/backend/.env.example`
   - Menyamakan URL MATS lokal agar konfigurasi REST dan WebSocket konsisten.

2. `SEKURITAS/backend/src/services/market-ws-proxy.ts`
   - Menambahkan warning jika `MATS_SERVICE_TOKEN` kosong.
   - WebSocket publik tetap masuk ke Sekuritas Backend, lalu diproxy ke MATS private.

3. `.gitignore`
   - Menambahkan ignore untuk artifact build native dan folder backup.

4. `start-all.bat`
   - Menambahkan mode local/tunnel.
   - Menjalankan DB, migration, BEI, MATS, Sekuritas Backend, frontend preview, dan Cloudflare Tunnel sesuai mode.
   - Menambahkan handling kegagalan untuk Docker, migration, dan frontend build.

5. `BEI/src/db/migrate.ts`
   - Menambahkan compatibility migration agar seed BEI idempotent.
   - Membersihkan duplicate seed lama pada rule profile, lot size, tick size, price band, auto rejection, session template, fee schedule, dan market index.
   - Menambahkan unique index yang diperlukan oleh seed agar `npm run db:seed` bisa dijalankan ulang dengan aman.

### Frontend

1. `SEKURITAS/frontend/src/pages/Dashboard.tsx`
   - Menambahkan reconnect WebSocket dengan backoff.
   - Menutup socket dengan bersih saat komponen unmount.

2. `SEKURITAS/frontend/vite.config.ts`
   - Menambahkan allowed host untuk domain tunnel saat development.

3. `SEKURITAS/frontend/package.json` dan `package-lock.json`
   - Menghapus dependency `axios` yang tidak dipakai.
   - Menyinkronkan lockfile agar `npm ci` tidak stale.

### Scripts Operasional

1. `scripts/backup-local-dbs.ps1`
   - Backup Sekuritas, MATS, dan BEI.
   - Memakai `pg_dump` lokal jika tersedia.
   - Fallback otomatis ke `docker exec pg_dump` jika `pg_dump` tidak ada di PATH.
   - Mengisolasi error per database dan menampilkan ringkasan hasil.

2. `scripts/restore-local-db.ps1`
   - Restore Sekuritas, MATS, atau BEI.
   - Memakai `psql` lokal jika tersedia.
   - Fallback otomatis ke `docker exec psql` jika `psql` tidak ada di PATH.
   - Menambahkan konfirmasi manual sebelum overwrite.
   - Restore berjalan dalam single transaction (`-1`).

## Validasi Build dan Test

| Area | Perintah | Hasil |
|---|---|---|
| BEI | `npm run build` | Berhasil |
| BEI migration | `npm run db:migrate` | Berhasil |
| BEI seed | `npm run db:seed` | Berhasil dan idempotent |
| Sekuritas Backend | `npm run build` | Berhasil |
| Sekuritas Backend tests | `npm test -- --run` | Berhasil, 4 file dan 8 test |
| Sekuritas Frontend tunnel | `npm run build:tunnel` | Berhasil |
| Sekuritas Frontend lockfile | `npm ci --dry-run` | Berhasil |

Validasi tambahan:

- Tidak ada referensi `axios` tersisa di `SEKURITAS/frontend/package.json` atau `package-lock.json`.
- Tidak ada token service yang terekspos di output build frontend.
- Tidak ada referensi `localhost` MATS/BEI yang ikut masuk ke bundle frontend publik.

## Validasi Runtime

Health check lokal berhasil:

- `http://localhost:3002/health`
- `http://localhost:8082/health`
- `http://localhost:4100/health`

Health check publik berhasil:

- `https://api-mandala-sekuritas.michaelk.fun/health`
- `https://mandala-sekuritas.michaelk.fun`

Cloudflare Tunnel berhasil mengarah ke:

- Frontend local preview di `localhost:4173`
- Sekuritas Backend di `localhost:3002`

## Validasi Trading End-to-End Publik

Flow publik berhasil diuji melalui `https://api-mandala-sekuritas.michaelk.fun`:

1. Register buyer dan seller.
2. Verify user.
3. Login.
4. Top up cash buyer.
5. Tambahkan posisi saham seller.
6. Submit SELL order MNDL 100 lot/share simulasi di harga 320.
7. Submit BUY order MNDL di harga yang sama.
8. Order matching terjadi di MATS.
9. BUY dan SELL sama-sama menjadi `filled`.
10. Fill muncul di endpoint fills.
11. Portfolio buyer berubah: cash berkurang dan posisi saham bertambah.
12. Notifikasi settlement muncul.
13. Custody summary, reconciliation, notifications, fills, dan leaderboard berhasil diakses.

Catatan hasil test:

- Buyer test: `stage3-buyer-20260619013215@example.com`
- Seller test: `stage3-seller-20260619013215@example.com`
- Trade test: `MATS-T-231`
- BUY order test: `444100fc-a84f-43e9-90a6-bd337c854eeb`
- SELL order test: `9d12d4df-2d9c-416f-b638-57163d92be83`

Data test tersebut berada di database lokal dan boleh dibersihkan jika diperlukan.

## Validasi Backup dan Restore

Backup berhasil dijalankan dengan fallback Docker:

- `backups/mandala_sekuritas_20260619_013549.sql`
- `backups/mandala_mats_20260619_013549.sql`
- `backups/mandala_bei_20260619_013549.sql`

Restore berhasil dites ke database disposable di masing-masing container, lalu database disposable dihapus:

| Target | Hasil |
|---|---|
| Sekuritas | Restore test berhasil, 19 table terbaca |
| MATS | Restore test berhasil, 5 table terbaca |
| BEI | Restore test berhasil, 28 table terbaca |

Restore aktif ke database utama tetap harus dilakukan hanya saat benar-benar dibutuhkan karena akan menimpa data.

## Catatan Operasional

- Service dan tunnel sempat dijalankan di background untuk validasi runtime.
- Docker Desktop harus aktif sebelum menjalankan `start-all.bat`.
- Untuk PowerShell, jalankan script dari root repo dengan `.\start-all.bat tunnel`, bukan `start-all.bat tunnel`.
- Cloudflare Tunnel credential tetap berada di mesin lokal dan tidak boleh masuk git.
- Backup di folder `backups/` harus disalin ke external drive atau cloud pribadi jika data mulai penting.
- Secret/token development masih perlu diganti sebelum dipakai publik dalam jangka panjang.

## Sisa Hardening Opsional

Item berikut tidak menghalangi eksekusi Tahap 3, tetapi disarankan sebelum penggunaan lebih serius:

1. Ganti semua token placeholder development.
2. Jalankan `cloudflared` sebagai Windows Service.
3. Tambahkan scheduled task untuk backup harian.
4. Tambahkan backup rotation/cleanup.
5. Tambahkan firewall rule eksplisit untuk port BEI, MATS, Postgres, dan Redis.
6. Tambahkan observability sederhana untuk error backend, reconnect WebSocket, dan status tunnel.
7. Pertimbangkan root Docker Compose untuk semua service setelah flow lokal stabil.
