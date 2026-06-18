# Log Implementasi Tahap 3 — Local Hybrid Hosting

> Tanggal eksekusi: 2026-06-19

## Ringkasan

Tahap 3 mengimplementasikan Mandala Exchange dengan **local hybrid hosting**: semua service berjalan lokal, Cloudflare Tunnel meng-expose frontend dan API publik, sedangkan MATS dan BEI tetap privat.

## Audit Konsistensi

### Hasil Audit
Audit dilakukan terhadap 23+ file konfigurasi, backend, frontend, dan script.

| Config Item | start-all.bat | docker-compose | .env.example | app.ts | tunnel.yml | Status |
|---|---|---|---|---|---|---|
| Sekuritas Backend port | 3002 | — | 3002 | — | 3002 | ✅ Konsisten |
| Frontend preview port | 4173 | — | — | CORS 4173 | 4173 | ✅ Konsisten |
| Vite dev port | — | — | — | CORS 5173 | — | ✅ Konsisten |
| Postgres Sekuritas port | — | 5432 | 5432 | — | — | ✅ Konsisten |
| BEI port | 4100 | — | 4100 | — | — | ✅ Konsisten |
| MATS port | 8082 | — | 8082 | — | — | ✅ Konsisten |
| Tunnel frontend hostname | ✅ | — | ✅ | ✅ CORS | ✅ | ✅ Konsisten |
| Tunnel API hostname | ✅ | — | — | — | ✅ | ✅ Konsisten |

**Tidak ditemukan mismatch port atau CORS kritis.**

## Perbaikan yang Dilakukan

### Backend & Infrastruktur

1. **`SEKURITAS/backend/.env.example`** — Fix inkonsistensi URL
   - `MATS_MARKET_WS_URL` diubah dari `ws://127.0.0.1:8082/...` → `ws://localhost:8082/...` agar konsisten dengan `MATS_API_URL`

2. **`SEKURITAS/backend/src/services/market-ws-proxy.ts`** — Warning log token kosong
   - Ditambahkan `console.warn` saat `MATS_SERVICE_TOKEN` kosong, memudahkan debugging jika upstream auth gagal

3. **`.gitignore`** — Go build artifacts
   - Ditambahkan pattern: `*.exe`, `*.exe~`, `*.dll`, `*.so`, `*.dylib`, `bin/`

4. **`start-all.bat`** — Error handling
   - Setiap `docker compose up -d` dicek errorlevel, warn jika gagal (tetap lanjut)
   - Setiap `npm run db:migrate` dicek errorlevel, warn jika gagal (tetap lanjut)
   - Frontend build dicek errorlevel, **exit /b 1 jika gagal** (service tidak bisa jalan tanpa build)

### Frontend

5. **`SEKURITAS/frontend/src/pages/Dashboard.tsx`** — WebSocket reconnection
   - Ditambahkan exponential backoff reconnect (1s → 30s max)
   - `useRef` untuk tracking socket dan mounted state
   - Clean close saat unmount (set `mountedRef` ke false)
   - Handler `onerror` yang log dan close, `onclose` yang trigger reconnect

6. **`SEKURITAS/frontend/vite.config.ts`** — Server allowedHosts
   - Ditambahkan `server: { allowedHosts: ['mandala-sekuritas.michaelk.fun'] }` untuk dev mode behind tunnel

7. **`SEKURITAS/frontend/package.json`** — Hapus dependency unused
   - `axios` dihapus dari dependencies (client.ts menggunakan native `fetch`)

### Scripts & Safety

8. **`scripts/backup-local-dbs.ps1`** — Error isolation
   - Setiap `pg_dump` dibungkus try/catch agar database lain tetap di-backup jika satu gagal
   - Ditambahkan tracking failures dan summary di akhir
   - Ditambahkan komentar tentang `PGPASSWORD`/`.pgpass` untuk non-interactive use

9. **`scripts/restore-local-db.ps1`** — Confirmation & atomicity
   - Ditambahkan prompt konfirmasi sebelum restore
   - Ditambahkan flag `-1` (single-transaction) ke `psql` agar restore atomic

## Validasi Build

| Build | Perintah | Hasil | Output |
|---|---|---|---|
| Backend Sekuritas | `npm run build` (`tsc`) | ✅ Berhasil | Tidak ada error TypeScript |
| Frontend (local mode) | `npm run build` | ✅ Berhasil | 1789 modules, 231.51 KB JS (gzip 72.68 KB) |
| Frontend (tunnel mode) | `npm run build:tunnel` | ✅ Berhasil | 1789 modules, 231.56 KB JS (gzip 72.67 KB) |

## Catatan & Sisa Pekerjaan

### Yang Perlu Validasi Runtime (membutuhkan semua service berjalan)
- Health check lokal: Sekuritas `:3002/health`, MATS `:8082/health`, BEI `:4100/health`
- Health check publik: `https://api-mandala-sekuritas.michaelk.fun/health`
- Flow trading end-to-end dari domain publik
- WebSocket reconnect behavior di produksi
- Backup/restore script terhadap database aktif

### Sisa Hardening (opsional/future)
- Tambahkan backup rotation/cleanup di `backup-local-dbs.ps1`
- Pertimbangkan `pg_dump --format=custom` untuk kompresi
- Tighten CORS null-origin policy untuk produksi
- Tambahkan max-clients limit di WebSocket proxy
- Pertimbangkan rename `VITE_MATS_WS_URL` → `VITE_MARKET_WS_URL` (nama saat ini misleading)
