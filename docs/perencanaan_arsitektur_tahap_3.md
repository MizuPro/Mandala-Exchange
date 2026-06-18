# Perencanaan Arsitektur Tahap 3: Local Hybrid Hosting & Cloudflare Tunnel

Dokumen ini mendokumentasikan rencana **Tahap 3** untuk menjalankan Mandala Exchange dengan pola **Local Hybrid Hosting**: laptop lokal menjadi server utama untuk engine, database, dan bot, sedangkan **Cloudflare Tunnel** hanya dipakai untuk akses player dari luar rumah.

Dokumen ini sudah disesuaikan dengan kondisi project saat ini:

- Service utama: `BEI`, `MATS`, `SEKURITAS/backend`, dan `SEKURITAS/frontend`.
- BEI dan MATS sudah punya Docker Compose database lokal.
- Sekuritas sudah ditambahkan Docker Compose database lokal di `SEKURITAS/docker-compose.yml`.
- Frontend React sudah memakai resolver endpoint untuk REST API dan WebSocket.
- Frontend publik memakai WebSocket proxy Sekuritas Backend agar MATS tetap privat.
- `playground.html` sudah dipindah ke `SEKURITAS/frontend/devtools/playground.html` agar tidak ikut disajikan sebagai UI publik.

Status saat ini: **siap untuk dieksekusi dan divalidasi end-to-end**. Bagian yang masih manual adalah memastikan Docker Desktop aktif, menjalankan startup mode yang benar, memastikan Cloudflare Tunnel aktif, mengganti secret/token placeholder jika akan dipakai publik lebih lama, dan menjalankan checklist validasi.

---

## 1. Keputusan Arsitektur

### Keputusan Utama

1. **Yang boleh dipublikkan via Cloudflare Tunnel**
   - Sekuritas Frontend React.
   - Sekuritas Backend API.

2. **Yang tetap privat**
   - MATS Engine.
   - BEI Service.
   - PostgreSQL lokal.
   - Redis lokal.
   - Bot trader.
   - Admin/internal endpoint lintas service.

3. **Frontend publik yang disarankan**
   - Gunakan aplikasi React utama di `SEKURITAS/frontend`.
   - `playground.html` hanya boleh dipakai sebagai devtool lokal di `SEKURITAS/frontend/devtools/`, bukan UI publik.

4. **Market realtime / WebSocket**
   - Keputusan: MATS tetap privat.
   - Frontend publik tetap boleh memakai WebSocket, tetapi WebSocket harus masuk ke Sekuritas Backend sebagai proxy.
   - Sekuritas Backend membuka endpoint publik seperti `wss://api-mandala-sekuritas.michaelk.fun/api/v1/market/ws`, lalu Sekuritas yang meneruskan/subscriber ke MATS secara internal.

5. **Database lokal**
   - Keputusan: gunakan Docker Compose untuk database lokal agar setup mudah diulang.
   - BEI sudah memakai PostgreSQL lokal di Docker pada port host `5441`.
   - MATS sudah memakai PostgreSQL lokal di Docker pada port host `5434`.
   - Sekuritas sudah memakai Docker Compose database lokal sendiri pada port host `5432`.

6. **Frontend publik**
   - Keputusan: gunakan React app utama di `SEKURITAS/frontend`.
   - Frontend publik disajikan dari hasil `npm run build:tunnel` lalu `npm run preview` di port `4173`.

7. **Binding service privat**
   - Keputusan: BEI dan MATS bind ke `127.0.0.1`.
   - Service privat tidak dibuka langsung ke LAN atau internet kecuali ada kebutuhan debugging sementara.

8. **Startup dan backup**
   - Keputusan: tetap gunakan `start-all.bat` untuk fase debugging, dengan mode `local` dan `tunnel`.
   - Backup memakai `scripts/backup-local-dbs.ps1` dan hasilnya disalin ke external drive atau cloud pribadi.

---

## 2. Latar Belakang

Pada tahap awal, Mandala Exchange diarahkan ke arsitektur cloud/hybrid:

- Backend Sekuritas direncanakan di hosting publik.
- BEI dan MATS berjalan lokal atau semi-lokal.
- Database Sekuritas pernah diarahkan ke NeonDB.

Masalah yang muncul:

1. **Latency database cloud terlalu tinggi**
   - Koneksi dari Indonesia ke region cloud seperti US-East dapat menambah ratusan milidetik per round trip.
   - Alur trading Mandala Exchange punya banyak operasi berantai: reserve cash/shares, submit order, matching, trade capture, settlement, custody, dan reconciliation.

2. **Bot dapat membebani cloud/tunnel**
   - Simulasi 100-500 bot akan menghasilkan trafik dan write load besar.
   - Trafik bot sebaiknya tidak keluar ke internet.

3. **Kebutuhan user sebenarnya kecil**
   - Target awal hanya 2 player manusia.
   - Sebagian besar waktu player berada di LAN yang sama.
   - Akses luar rumah tetap dibutuhkan, tetapi hanya untuk trafik player manusia.

Karena itu, arsitektur local hybrid lebih masuk akal untuk fase ini.

---

## 3. Diagram Arsitektur Target

```mermaid
graph TD
    subgraph Internet
        PlayerOut[Player luar rumah - Browser/HP]
    end

    subgraph Cloudflare
        Tunnel[Cloudflare Tunnel]
    end

    subgraph Laptop Lokal
        subgraph PublicViaTunnel[Exposed via Tunnel]
            FE[Sekuritas Frontend React]
            API[Sekuritas Backend API / port 3002]
        end

        subgraph PrivateLocal[Privat Lokal]
            DBSek[(Postgres Sekuritas)]
            DBMats[(Postgres MATS / host port 5434)]
            DBBei[(Postgres BEI / host port 5441)]
            Redis[(Redis / host port 6379)]
            MATS[MATS Engine / port 8082]
            BEI[BEI Service / port 4100]
            Bots[Bot Trader Lokal]
        end
    end

    PlayerOut -->|mandala-sekuritas.michaelk.fun| Tunnel
    PlayerOut -->|api-mandala-sekuritas.michaelk.fun| Tunnel
    Tunnel --> FE
    Tunnel --> API

    FE -->|REST API| API
    FE -->|WebSocket market data| API
    API --> DBSek
    API -->|order gateway| MATS
    API -->|private WS/proxy subscriber| MATS
    API -->|market/settlement/custody read| BEI
    MATS --> DBMats
    MATS -->|trade capture/session sync| BEI
    MATS --> Redis
    BEI --> DBBei
    BEI --> Redis
    BEI -->|settlement webhook| API
    Bots -->|localhost:3002| API
```

Catatan:

- Frontend publik tidak boleh memakai `ws://localhost:8082` karena `localhost` di browser berarti device player, bukan laptop server.
- WebSocket publik diarahkan ke Sekuritas Backend, lalu Sekuritas meneruskan stream dari MATS secara internal.
- MATS tetap tidak punya hostname publik pada desain default.

---

## 4. Mapping Kondisi Project Saat Ini

| Area | Kondisi Saat Ini | Implikasi Tahap 3 |
| --- | --- | --- |
| Frontend API | `SEKURITAS/frontend/src/api/client.ts` memakai `resolveApiBase()` | Sudah cocok untuk lokal dan tunnel. Domain publik dipaksa ke `https://api-mandala-sekuritas.michaelk.fun/api/v1`. |
| Frontend WebSocket | `Dashboard.tsx` memakai `resolveMarketWsUrl()` | Sudah mengarah ke WebSocket proxy Sekuritas saat host publik dipakai. |
| Sekuritas CORS | `SEKURITAS/backend/src/app.ts` membaca `FRONTEND_ORIGINS` | Sudah configurable via env dengan default lokal + domain final. |
| Playground HTML | `playground.html` dipindah ke `SEKURITAS/frontend/devtools/` | Tidak ikut build publik Vite. |
| BEI DB | `BEI/docker-compose.yml` memakai Postgres host port `5441` | Sudah cocok untuk lokal. |
| MATS DB | `MATS/docker-compose.yml` memakai Postgres host port `5434` | Sudah cocok untuk lokal. |
| Sekuritas DB | `SEKURITAS/docker-compose.yml` menjalankan Postgres `mandala_sekuritas` pada host port `5432` | Sudah siap untuk migration Sekuritas. |
| Startup | `start-all.bat` menjalankan DB BEI/MATS/Sekuritas, migration BEI/Sekuritas, service, frontend preview, dan opsional tunnel | Gunakan `start-all.bat local` atau `start-all.bat tunnel`. |
| Internal token | BEI/MATS/Sekuritas sudah memakai service token | Token harus diganti dari placeholder sebelum tunnel publik. |

---

## 5. Konfigurasi Domain dan Tunnel

### Hostname Final

- `mandala-sekuritas.michaelk.fun` -> Sekuritas Frontend.
- `api-mandala-sekuritas.michaelk.fun` -> Sekuritas Backend.

Jangan expose domain publik untuk BEI atau MATS pada tahap default.

### Contoh `cloudflared` Config

Untuk frontend stabil, lebih baik expose hasil build/preview, bukan Vite dev server. Contoh:

```yaml
tunnel: <UUID-TUNNEL-ANDA>
credentials-file: C:\Users\micha\.cloudflared\<UUID-TUNNEL-ANDA>.json

ingress:
  - hostname: mandala-sekuritas.michaelk.fun
    service: http://localhost:4173

  - hostname: api-mandala-sekuritas.michaelk.fun
    service: http://localhost:3002

  - service: http_status:404
```

Catatan:

- Port `4173` adalah port default `vite preview`.
- Untuk development cepat, boleh sementara arahkan `mandala-sekuritas.michaelk.fun` ke `http://localhost:5173`, tetapi itu bukan pilihan paling stabil untuk akses luar rumah.
- Pastikan tunnel hanya berjalan ketika laptop memang siap menjadi server.

---

## 6. Konfigurasi Environment

### 6.1 Sekuritas Frontend

File yang dipakai:

- `SEKURITAS/frontend/.env.local` untuk mode lokal.
- `SEKURITAS/frontend/.env.development` untuk Vite dev lokal.
- `SEKURITAS/frontend/.env.tunnel` untuk build publik via Cloudflare Tunnel.

Mode lokal:

```env
VITE_API_URL=http://localhost:3002/api/v1
VITE_MATS_WS_URL=ws://localhost:3002/api/v1/market/ws
```

Mode akses luar rumah:

```env
VITE_API_URL=https://api-mandala-sekuritas.michaelk.fun/api/v1
VITE_MATS_WS_URL=wss://api-mandala-sekuritas.michaelk.fun/api/v1/market/ws
```

Untuk WebSocket market data, gunakan proxy Sekuritas Backend.

#### Keputusan: WebSocket Proxy via Sekuritas

Frontend publik tidak boleh mengarah langsung ke MATS. Arahkan WebSocket frontend ke Sekuritas Backend.

```env
VITE_API_URL=https://api-mandala-sekuritas.michaelk.fun/api/v1
VITE_MATS_WS_URL=wss://api-mandala-sekuritas.michaelk.fun/api/v1/market/ws
```

Desain proxy:

- Browser player membuka WebSocket ke Sekuritas Backend.
- Sekuritas Backend membuka satu koneksi internal ke MATS market stream, atau subscribe ke MATS hub secara internal.
- Sekuritas Backend melakukan fan-out event ke browser player yang sedang terhubung.
- Token MATS `market:read` tetap berada di backend dan tidak dikirim ke browser.

Catatan beban:

- Untuk target 2 player manusia, tambahan beban proxy ini kecil.
- Beban utama tetap berasal dari bot dan matching engine lokal, bukan dari 2 koneksi WebSocket player.
- Pola yang perlu dihindari adalah Sekuritas membuka 1 koneksi ke MATS untuk setiap browser jika user bertambah banyak. Lebih baik Sekuritas membuka 1 koneksi/subscription internal lalu broadcast ke semua client.
- Jika nanti jumlah client naik, tambahkan filtering symbol, throttling update, heartbeat, reconnect policy, dan rate limit.

Catatan implementasi:

- Resolver endpoint frontend berada di `SEKURITAS/frontend/src/config/endpoints.ts`.
- Saat halaman dibuka dari `mandala-sekuritas.michaelk.fun`, frontend selalu memakai endpoint publik Cloudflare meskipun build lokal tidak sengaja terserve.
- `npm run build` dan `npm run build:tunnel` membersihkan folder `dist` terlebih dahulu agar asset lama tidak ikut terserve.

### 6.2 Sekuritas Backend

File: `SEKURITAS/backend/.env`

```env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/mandala_sekuritas
PORT=3002
JWT_SECRET=<jwt-secret-kuat>
ADMIN_TOKEN=<admin-token-kuat>
BROKER_CODE=MANDALA

MATS_API_URL=http://localhost:8082
MATS_MARKET_WS_URL=ws://127.0.0.1:8082/v1/market-data/ws
MATS_SERVICE_TOKEN=<token-sekuritas-ke-mats>
MATS_TO_SEKURITAS_TOKEN=<token-mats-ke-sekuritas>

BEI_API_URL=http://localhost:4100
BEI_SERVICE_TOKEN=<token-sekuritas-ke-bei>
BEI_TO_SEKURITAS_TOKEN=<token-bei-ke-sekuritas>

FRONTEND_ORIGINS=http://localhost:5173,http://localhost:4173,https://mandala-sekuritas.michaelk.fun
```

Catatan implementasi:

- `SEKURITAS/backend/src/app.ts` sudah membaca CORS origin dari `FRONTEND_ORIGINS`.
- Jangan hardcode domain tunnel di kode.

### 6.3 MATS

File: `MATS/.env`

Gunakan nama env sesuai codebase MATS saat ini:

```env
MATS_HTTP_ADDR=127.0.0.1:8082
MATS_DATABASE_URL=postgres://mandala_mats:mandala_mats@localhost:5434/mandala_mats?sslmode=disable
MATS_SERVICE_TOKENS=[{"name":"sekuritas","token":"<token-sekuritas-ke-mats>","scopes":["order:write","order:read","market:read"]},{"name":"bei","token":"<token-bei-ke-mats>","scopes":["admin:read","market:read"]},{"name":"admin","token":"<admin-token-kuat>","scopes":["admin:*","sync:write","order:read","market:read"]}]

BEI_BASE_URL=http://localhost:4100/v1
BEI_SERVICE_TOKEN=<token-mats-ke-bei>

SEKURITAS_EVENTS_URL=http://localhost:3002/internal/mats/events
SEKURITAS_SERVICE_TOKEN=<token-mats-ke-sekuritas>

MATS_SESSION_ID=local-session
MATS_SYNC_INTERVAL_SECONDS=60
MATS_DELIVERY_MAX_ATTEMPTS=5
REDIS_URL=redis://localhost:6379
```

Catatan:

- Gunakan `127.0.0.1:8082` jika MATS hanya boleh diakses dari laptop lokal.
- Jika bot berjalan di laptop yang sama, `127.0.0.1` tetap cukup.
- Jika ada device LAN yang memang perlu akses langsung ke MATS, ubah binding dan batasi dengan firewall.

### 6.4 BEI

File: `BEI/.env`

```env
NODE_ENV=development
PORT=4100
HOST=127.0.0.1
DATABASE_URL=postgres://mandala_bei:mandala_bei@localhost:5441/mandala_bei

BEI_SERVICE_TOKENS=[{"name":"admin","token":"<admin-token-kuat>","scopes":["admin:*"]},{"name":"mats","token":"<token-mats-ke-bei>","scopes":["market:read","rules:read","broker:read","trade:capture","market-summary:write","session:write"]},{"name":"sekuritas","token":"<token-sekuritas-ke-bei>","scopes":["market:read","rules:read","broker:read","settlement:read","custody:read","corporate-action:read","report:read"]},{"name":"readonly","token":"<readonly-token-kuat>","scopes":["market:read","rules:read","broker:read","corporate-action:read","report:read"]}]

SEKURITAS_SETTLEMENT_WEBHOOK_URL=http://localhost:3002/internal/webhook/bei/settlement
SEKURITAS_CORPORATE_ACTION_WEBHOOK_URL=http://localhost:3002/internal/webhook/bei/corporate-action
BEI_TO_SEKURITAS_TOKEN=<token-bei-ke-sekuritas>

REDIS_URL=redis://localhost:6379
```

Catatan:

- `HOST=127.0.0.1` membuat BEI hanya listen di loopback laptop.
- Jika ingin diakses dari LAN untuk debugging, gunakan `0.0.0.0` hanya sementara dan batasi firewall.

---

## 7. Database Lokal

### 7.1 BEI dan MATS

BEI dan MATS sudah memiliki Docker Compose masing-masing:

- `BEI/docker-compose.yml`
- `MATS/docker-compose.yml`

Port host:

- BEI Postgres: `localhost:5441`
- MATS Postgres: `localhost:5434`
- Redis: `localhost:6379` dari compose BEI

### 7.2 Sekuritas

Sekuritas membutuhkan database `mandala_sekuritas`.

Keputusan untuk Tahap 3: **gunakan Docker Compose untuk database Sekuritas** agar konsisten dengan BEI dan MATS.

Implementasi saat ini:

- Database: `mandala_sekuritas`
- User: `postgres`
- Password default lokal: `postgres`
- Port host: `5432`
- Compose file: `SEKURITAS/docker-compose.yml`
- Migration runner: `SEKURITAS/backend/src/db/migrate.ts`
- Migration SQL: `SEKURITAS/backend/src/db/migrations/0000_initial_schema.sql`

`start-all.bat` sudah diperbarui agar:

1. Menyalakan DB BEI, DB MATS, Redis, dan DB Sekuritas.
2. Menjalankan migration BEI.
3. Menjalankan migration Sekuritas.
4. Menjalankan service BEI, MATS, Sekuritas Backend, dan Sekuritas Frontend.
5. Mendukung mode `local` dan `tunnel`.

---

## 8. Catatan PostgreSQL Performance

Optimasi database lokal boleh dilakukan, tetapi jangan dijadikan default tanpa memahami risikonya.

Opsi aman awal:

```ini
shared_buffers = 512MB
work_mem = 16MB
```

Opsi cepat tetapi berisiko:

```ini
synchronous_commit = off
```

Catatan:

- `synchronous_commit = off` bisa mempercepat write load bot.
- Namun jika laptop mati mendadak, transaksi terakhir berisiko hilang.
- Untuk data ledger, settlement, custody, dan reconciliation, opsi ini sebaiknya hanya dipakai untuk load test atau simulasi yang bisa di-reset.

---

## 9. Security Checklist Sebelum Tunnel Publik

Sebelum `api-mandala-sekuritas.michaelk.fun` dibuka:

1. Ganti semua placeholder token.
2. Gunakan `JWT_SECRET` kuat dan berbeda dari development.
3. Batasi CORS Sekuritas hanya ke domain frontend yang valid.
4. Jangan expose BEI dan MATS secara default.
5. Jangan publish `SEKURITAS/frontend/devtools/playground.html` sebagai UI player.
6. Pastikan admin endpoint Sekuritas memakai `ADMIN_TOKEN` kuat.
7. Pastikan service token internal tidak pernah dimasukkan ke frontend.
8. Jika MATS WebSocket ikut diexpose, gunakan token market khusus dengan scope minimal dan rate limiting.
9. Aktifkan firewall Windows untuk menolak koneksi inbound langsung ke port privat jika tidak diperlukan.
10. Jangan commit file `.env`.

---

## 10. Startup dan Ketahanan Laptop

### Power Plan

Atur Windows agar laptop tidak sleep saat menjadi server:

- Sleep: Never saat plugged in.
- Hibernate: Off atau durasi panjang.
- Turn off hard disk: Never saat plugged in.
- Lid close action: Do nothing saat plugged in.

### Startup Service

Keputusan saat ini:

- Tetap gunakan `start-all.bat` untuk fase debugging.
- `start-all.bat` mendukung mode:
  - `start-all.bat` atau `start-all.bat local`: build frontend lokal dan start service lokal.
  - `start-all.bat tunnel`: build frontend mode tunnel, start service lokal, dan mencoba menjalankan `cloudflared tunnel run mandala-exchange`.
- Setelah stabil, pisahkan script:
  - `start-infra.bat`
  - `migrate-all.bat`
  - `start-services.bat`
  - `start-tunnel.bat`
- Jalankan `cloudflared` sebagai Windows Service setelah konfigurasi tunnel stabil.

### Catatan: Docker Compose untuk Semua Service

Docker Compose untuk semua service berarti tidak hanya database yang dijalankan di container, tetapi juga:

- BEI service.
- MATS service.
- Sekuritas Backend.
- Sekuritas Frontend build/preview.
- PostgreSQL BEI.
- PostgreSQL MATS.
- PostgreSQL Sekuritas.
- Redis.
- Opsional: cloudflared.

Contoh gambaran service:

```yaml
services:
  bei-db:
    image: postgres:16-alpine

  mats-db:
    image: postgres:17-alpine

  sekuritas-db:
    image: postgres:16-alpine

  redis:
    image: redis:7-alpine

  bei:
    build: ./BEI
    depends_on:
      - bei-db
      - redis

  mats:
    build: ./MATS
    depends_on:
      - mats-db
      - bei
      - redis

  sekuritas-backend:
    build: ./SEKURITAS/backend
    depends_on:
      - sekuritas-db
      - mats
      - bei

  sekuritas-frontend:
    build: ./SEKURITAS/frontend
    depends_on:
      - sekuritas-backend
```

Kelebihan:

- Satu perintah bisa menjalankan seluruh sistem.
- Dependency antar service lebih eksplisit.
- Port, volume, env, dan restart policy terkumpul di satu tempat.
- Lebih mudah dipindah ke mesin lain atau VPS jika nanti dibutuhkan.

Kekurangan:

- Perlu membuat Dockerfile untuk BEI, MATS, Sekuritas Backend, dan Frontend.
- Debugging hot reload bisa lebih lambat dibanding menjalankan service langsung di terminal.
- Volume, migration, seed, dan urutan startup harus dirancang rapi.
- Di Windows, Docker Desktop bisa memakai RAM/CPU lebih besar.

Kesimpulan untuk tahap ini:

- Gunakan `start-all.bat` dulu agar perubahan lebih kecil dan debugging tetap mudah.
- Tambahkan Docker Compose hanya untuk database Sekuritas.
- Setelah local hybrid stabil, baru pertimbangkan root `docker-compose.yml` untuk semua service sebagai fase hardening/deployment.

---

## 11. Backup dan Restore

Karena database pindah ke laptop, backup wajib masuk rencana.

Script yang tersedia:

- Backup: `scripts/backup-local-dbs.ps1`
- Restore: `scripts/restore-local-db.ps1`

Backup manual:

```powershell
.\scripts\backup-local-dbs.ps1
```

Backup ke folder tertentu:

```powershell
.\scripts\backup-local-dbs.ps1 -OutputDir E:\MandalaBackups
```

Restore:

```powershell
.\scripts\restore-local-db.ps1 -Target sekuritas -BackupFile .\backups\mandala_sekuritas_YYYYMMDD_HHMMSS.sql
.\scripts\restore-local-db.ps1 -Target mats -BackupFile .\backups\mandala_mats_YYYYMMDD_HHMMSS.sql
.\scripts\restore-local-db.ps1 -Target bei -BackupFile .\backups\mandala_bei_YYYYMMDD_HHMMSS.sql
```

Command internal yang dipakai backup:

```powershell
pg_dump -h localhost -p 5432 -U postgres mandala_sekuritas > backups/mandala_sekuritas_%DATE%.sql
pg_dump -h localhost -p 5434 -U mandala_mats mandala_mats > backups/mandala_mats_%DATE%.sql
pg_dump -h localhost -p 5441 -U mandala_bei mandala_bei > backups/mandala_bei_%DATE%.sql
```

Catatan:

- Sesuaikan command dengan lokasi `pg_dump` di Windows.
- Jangan simpan backup hanya di disk yang sama.
- Minimal salin backup ke external drive atau cloud storage pribadi.
- Buat juga prosedur restore dan tes restore sesekali.
- Folder `backups/` dan file `*.backup.sql` sudah di-ignore oleh git.

---

## 12. Status Implementasi

Status codebase saat ini:

1. DB Sekuritas lokal via Docker Compose sudah tersedia di `SEKURITAS/docker-compose.yml`.
2. Migration Sekuritas sudah tersedia dan idempotent melalui `npm run db:migrate` dari `SEKURITAS/backend`.
3. `start-all.bat` sudah menjalankan DB BEI, MATS, Sekuritas, migration BEI, migration Sekuritas, service backend, MATS, BEI, dan frontend preview.
4. `start-all.bat tunnel` sudah menyiapkan build frontend tunnel dan mencoba menjalankan `cloudflared tunnel run mandala-exchange`.
5. CORS Sekuritas sudah membaca `FRONTEND_ORIGINS`.
6. WebSocket proxy publik sudah ada di `GET /api/v1/market/ws`.
7. Frontend publik sudah memakai endpoint Cloudflare untuk REST dan WebSocket saat dibuka dari `mandala-sekuritas.michaelk.fun`.
8. `playground.html` sudah dipindah ke folder devtools dan tidak lagi menjadi aset publik Vite.
9. Script backup/restore lokal sudah tersedia di folder `scripts/`.
10. Contoh config tunnel tersedia di `deploy/cloudflared/mandala-tunnel.example.yml`.

Status manual di luar repo:

1. Docker Desktop harus aktif sebelum startup.
2. Cloudflare Tunnel credential tetap berada di mesin lokal dan tidak boleh masuk git.
3. DNS Cloudflare untuk `mandala-sekuritas.michaelk.fun` dan `api-mandala-sekuritas.michaelk.fun` harus tetap diarahkan ke tunnel `mandala-exchange`.
4. Secret/token placeholder harus diganti jika environment ini akan dipakai publik lebih lama.
5. Backup hasil `pg_dump` perlu disalin ke external drive atau cloud pribadi.

Validasi final 2026-06-19:

1. Health check lokal Sekuritas, MATS, dan BEI berhasil.
2. Health check publik `https://api-mandala-sekuritas.michaelk.fun/health` berhasil.
3. Frontend publik `https://mandala-sekuritas.michaelk.fun` berhasil diakses melalui Cloudflare Tunnel.
4. Flow register, verify, login, top up, submit buy/sell order, matching, fill, settlement notification, custody summary, reconciliation, fills, dan leaderboard berhasil diuji lewat endpoint publik.
5. Backup Sekuritas, MATS, dan BEI berhasil dibuat.
6. Restore test berhasil pada database disposable untuk Sekuritas, MATS, dan BEI.
7. Catatan detail validasi tersedia di `docs/implementation-log/tahap-3-local-hybrid.md`.

---

## 13. Runbook Eksekusi

### 13.1 Eksekusi Lokal Tanpa Tunnel

Gunakan ini untuk debugging dari laptop sendiri.

```bat
start-all.bat local
```

Atau:

```bat
start-all.bat
```

Endpoint yang dipakai:

- Frontend preview: `http://localhost:4173`
- Sekuritas Backend: `http://localhost:3002`
- MATS: `http://localhost:8082`
- BEI: `http://localhost:4100`

### 13.2 Eksekusi Dengan Cloudflare Tunnel

Gunakan ini saat ingin dites dari HP atau jaringan luar rumah.

```bat
start-all.bat tunnel
```

Endpoint publik:

- Frontend: `https://mandala-sekuritas.michaelk.fun`
- API dan WebSocket: `https://api-mandala-sekuritas.michaelk.fun`
- WebSocket market: `wss://api-mandala-sekuritas.michaelk.fun/api/v1/market/ws`

Jika `cloudflared` tidak ditemukan oleh script, jalankan manual dari terminal lain:

```powershell
cloudflared tunnel run mandala-exchange
```

### 13.3 Health Check Setelah Startup

Jalankan setelah semua window service terbuka:

```powershell
Invoke-RestMethod http://localhost:3002/health
Invoke-RestMethod http://localhost:8082/health
Invoke-RestMethod http://localhost:4100/health
Invoke-RestMethod https://api-mandala-sekuritas.michaelk.fun/health
```

Catatan: health check publik hanya berhasil jika `start-all.bat tunnel` atau `cloudflared tunnel run mandala-exchange` sedang aktif.

### 13.4 Validasi Player Flow

Checklist minimum sebelum dianggap selesai:

1. Buka `https://mandala-sekuritas.michaelk.fun` dari laptop.
2. Buka domain yang sama dari HP memakai jaringan seluler atau Wi-Fi berbeda.
3. Register user baru.
4. Login.
5. Verify email/token sesuai flow aplikasi.
6. Pastikan dashboard memuat portfolio, market, order, settlement, notification, dan leaderboard tanpa `Failed to fetch`.
7. Pastikan browser tidak meminta izin akses jaringan lokal.
8. Pastikan market WebSocket tidak mengarah ke `localhost` dari browser publik.
9. Submit order kecil untuk flow beli/jual simulasi.
10. Cek order history, trade/fill, settlement, custody, dan reconciliation.

### 13.5 Validasi Backup

Jalankan:

```powershell
.\scripts\backup-local-dbs.ps1
```

Pastikan folder `backups/` berisi file:

- `mandala_sekuritas_<timestamp>.sql`
- `mandala_mats_<timestamp>.sql`
- `mandala_bei_<timestamp>.sql`

Tes restore sebaiknya dilakukan pada database disposable atau setelah backup tambahan dibuat.

---

## 14. Sisa Hardening Setelah Flow Stabil

Item ini tidak wajib untuk eksekusi pertama, tetapi perlu sebelum dipakai lebih serius:

1. Ganti semua secret/token development.
2. Pertimbangkan menjalankan `cloudflared` sebagai Windows Service.
3. Tambahkan scheduled task untuk backup harian.
4. Tambahkan firewall rule eksplisit agar port BEI/MATS/Postgres/Redis tidak menerima inbound dari jaringan luar.
5. Tambahkan observability sederhana untuk log error backend, reconnect WebSocket, dan status tunnel.
6. Pertimbangkan root Docker Compose untuk semua service setelah debugging lokal stabil.

---

## 15. Ringkasan Keputusan Final

Keputusan Tahap 3 yang dipakai:

1. Public tunnel hanya:
   - `mandala-sekuritas.michaelk.fun`
   - `api-mandala-sekuritas.michaelk.fun`

2. MATS dan BEI tetap privat:
   - `MATS_HTTP_ADDR=127.0.0.1:8082`
   - `HOST=127.0.0.1` untuk BEI

3. Frontend publik memakai `VITE_MATS_WS_URL` yang mengarah ke proxy Sekuritas Backend.

4. Tambahkan DB Sekuritas lewat Docker.

5. Frontend publik memakai React app utama dan disajikan dari hasil `npm run build` + `npm run preview`.

6. Jangan pakai `playground.html` untuk player publik.

7. Startup awal tetap memakai `start-all.bat`, dan script sudah include DB/migration Sekuritas.

8. Root Docker Compose untuk semua service dicatat sebagai opsi hardening/deployment setelah setup lokal stabil.

9. Backup memakai script `scripts/backup-local-dbs.ps1` dan hasilnya disalin ke external drive atau cloud pribadi.

Dengan pilihan ini, tahap 3 bisa dilakukan tanpa membuka internal engine ke internet dan tanpa memindahkan logika trading utama.
