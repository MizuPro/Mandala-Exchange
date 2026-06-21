# 🏛️ BEI Service (Bursa Efek Indonesia)

[![Node.js Version](https://img.shields.io/badge/Node.js-18%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Fastify](https://img.shields.io/badge/Fastify-4.0-000000?style=flat-square&logo=fastify&logoColor=white)](https://www.fastify.io)
[![Drizzle ORM](https://img.shields.io/badge/Drizzle--ORM-lightgreen?style=flat-square)](https://orm.drizzle.team)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15-4169E1?style=flat-square&logo=postgresql&logoColor=white)](https://www.postgresql.org)

**BEI Service** adalah pusat otoritas pasar (*market authority*) internal di dalam ekosistem Mandala Exchange. Layanan ini bertanggung jawab penuh sebagai *Single Source of Truth* untuk seluruh data emiten, saham yang tercatat, aturan perdagangan, data kustodian, penyelesaian transaksi (*settlement*), serta pengawasan dasar pasar.

---

## ⚡ Panduan Menjalankan Layanan (Quick Start)

Jalankan perintah berikut di folder `BEI` untuk memulai secara lokal:

```bash
# 1. Instalasi dependensi
npm install

# 2. Salin variabel lingkungan
cp .env.example .env

# 3. Jalankan container PostgreSQL lokal
docker compose up -d

# 4. Terapkan migrasi database & seed data awal
npm run db:migrate
npm run db:seed

# 5. Jalankan server dalam mode pengembangan
npm run dev
```

> [!TIP]
> Endpoint deteksi kesehatan aplikasi (*health check*) dapat diakses secara publik pada `GET /health`.

---

## 🔑 Otorisasi & Keamanan Service-to-Service

Semua endpoint API BEI (kecuali `/health`) dilindungi oleh sistem token internal. Anda wajib menyertakan token otorisasi pada header HTTP berikut:

```http
x-service-token: <secure-service-token>
```

Daftar token internal dikonfigurasi melalui variabel lingkungan `BEI_SERVICE_TOKENS` di file `.env` dengan format array JSON:

```env
BEI_SERVICE_TOKENS=[{"name":"admin","token":"replace-with-admin-token","scopes":["admin:*"]},{"name":"mats","token":"replace-with-mats-token","scopes":["market:read","rules:read","broker:read","trade:capture","market-summary:write"]},{"name":"sekuritas","token":"replace-with-sekuritas-token","scopes":["market:read","rules:read","broker:read","settlement:read","custody:read","corporate-action:read","report:read"]},{"name":"readonly","token":"replace-with-readonly-token","scopes":["market:read","rules:read","broker:read","corporate-action:read","report:read"]}]
```

### Tabel Lingkup Hak Akses (Scopes)

| Cakupan (Scope) | Penerima | Deskripsi Hak Akses |
| :--- | :--- | :--- |
| `admin:*` | Operator BEI / Admin | Akses penuh tanpa batas untuk seluruh endpoint administratif dan konfigurasi pasar. |
| `mats` | MATS Matching Engine | Membaca aturan perdagangan (*trading rules*), emiten, status sesi, memvalidasi broker, mengirim *trade capture*, dan menulis ringkasan pasar. |
| `sekuritas` | Mandala Sekuritas | Membaca data pasar, aturan biaya (*fees*), informasi kustodian, penyelesaian transaksi (*settlement*), aksi korporasi, dan laporan perdagangan. |
| `readonly` | Consumer / Dashboard | Akses baca terbatas untuk visualisasi data eksternal, dashboard monitoring, atau audit independen. |

> [!WARNING]
> Request dengan token valid tetapi lingkup (*scope*) tidak mencukupi akan menghasilkan response `403 Forbidden`. Request dengan token salah atau kosong akan menghasilkan `401 Unauthorized`.

---

## 📐 Batasan Layanan (Boundary System)

Dalam arsitektur Mandala Exchange, BEI Service memiliki cakupan batasan tanggung jawab sebagai berikut:

- **Single Source of Truth**: Menjadi pemegang otoritas tunggal untuk data emiten, listed security, regulasi/rules pasar, fee schedule, penyelesaian transaksi (*settlement*), aksi korporasi (*corporate action*), dan *custody ledger* (kepemilikan dana dan saham).
- **Matching Engine Hand-off**: BEI **tidak** memproses antrean order book real-time secara langsung. Tanggung jawab pencocokan transaksi diserahkan sepenuhnya kepada **MATS Service** yang kemudian mengirimkan transaksi final kembali ke BEI untuk pencatatan hukum (*trade capture*).
- **Client & Bot Access**: Semua trader retail dan automated trading bot **tidak diperbolehkan** menembus API BEI secara langsung. Akses wajib melalui perantara API **Mandala Sekuritas**.
