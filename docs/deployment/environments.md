# Mandala Exchange Environments

Mandala Exchange sekarang memakai dua mode runtime yang terpisah:

| Mode | Tujuan | Finance Mode | Public Tunnel |
|---|---|---|---|
| `development` | Simulator lokal dan testing cepat | `simulator` | Opsional |
| `production` | Deployment lokal via Cloudflare Tunnel | `rdn` | Wajib untuk domain publik |

## File Env

File env asli tetap ignored oleh git. Template yang boleh dicommit memakai suffix `.example`.

| Service | Development | Production |
|---|---|---|
| BEI runtime | `BEI/.env.development` | `BEI/.env.production` |
| BEI Docker | `BEI/.env.docker.development` | `BEI/.env.docker.production` |
| MATS runtime | `MATS/.env.development` | `MATS/.env.production` |
| MATS Docker | `MATS/.env.docker.development` | `MATS/.env.docker.production` |
| Sekuritas backend runtime | `SEKURITAS/backend/.env.development` | `SEKURITAS/backend/.env.production` |
| Sekuritas Docker | `SEKURITAS/.env.docker.development` | `SEKURITAS/.env.docker.production` |
| Sekuritas frontend runtime | `SEKURITAS/frontend/.env.development` | `SEKURITAS/frontend/.env.production` |

## Port Matrix

| Service | Development | Production |
|---|---:|---:|
| Sekuritas frontend preview | `4173` | `4174` |
| Sekuritas backend | `3002` | `3003` |
| Sekuritas PostgreSQL | `5432` | `5532` |
| BEI API | `4100` | `4101` |
| BEI PostgreSQL | `5441` | `5541` |
| Redis | `6379` | `6380` |
| MATS API | `8082` | `8083` |
| MATS PostgreSQL | `5434` | `5534` |

## Menjalankan Stack

Development:

```bat
start-all.bat development
```

Production:

```bat
start-all.bat production
```

Alias lama masih diterima:

```bat
start-all.bat local
start-all.bat tunnel
```

`local` diarahkan ke `development`, sedangkan `tunnel` diarahkan ke `production`.

## Cloudflare Tunnel

Untuk production, salin:

```text
deploy/cloudflared/mandala-tunnel.production.example.yml
```

menjadi:

```text
deploy/cloudflared/mandala-tunnel.production.yml
```

Lalu isi `tunnel` dan `credentials-file` sesuai konfigurasi Cloudflare lokal. Production tunnel harus mengarah ke:

- Frontend: `http://localhost:4174`
- Backend API: `http://localhost:3003`

## Aturan Dana

Development memakai `FINANCE_MODE=simulator`. Deposit dan withdrawal satu klik tetap tersedia, tetapi sekarang mutasi saldo dilakukan di backend dan dicatat di `ledger_movements`.

Production memakai `FINANCE_MODE=rdn`. Endpoint simulator akan ditolak, dan topup/withdraw mengembalikan status bahwa integrasi RDN Bank Mandala belum aktif. Implementasi RDN berikutnya mengacu ke `docs/perencanaan/rdn-integration-with-Bank-Mandala.md`.

## Checklist Production

- Pastikan semua token production berbeda dari development.
- Pastikan semua database production memakai port, user, database, dan volume production.
- Pastikan `SEKURITAS/backend/.env.production` memakai `FINANCE_MODE=rdn`.
- Pastikan `deploy/cloudflared/mandala-tunnel.production.yml` mengarah ke port production.
- Jalankan migrasi production hanya melalui `start-all.bat production` atau env production eksplisit.
- Backup database production sebelum perubahan schema besar.
