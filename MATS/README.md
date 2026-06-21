# ⚡ MATS Service (Mandala Automated Trading System)

[![Go Version](https://img.shields.io/badge/Go-1.20%2B-00ADD8?style=flat-square&logo=go&logoColor=white)](https://golang.org)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15-4169E1?style=flat-square&logo=postgresql&logoColor=white)](https://www.postgresql.org)
[![WebSockets](https://img.shields.io/badge/WebSockets-Enabled-lightgrey?style=flat-square&logo=websocket&logoColor=white)](https://html.spec.whatwg.org/multipage/web-sockets.html)
[![Docker](https://img.shields.io/badge/Docker-Container-2496ED?style=flat-square&logo=docker&logoColor=white)](https://www.docker.com)

**MATS (Mandala Automated Trading System)** adalah jantung dari sistem perdagangan di ekosistem Mandala Exchange. Layanan ini ditulis menggunakan bahasa pemrograman Go untuk performa tinggi, bertanggung jawab atas penerimaan order dari Sekuritas, validasi kesesuaian order terhadap aturan bursa (*BEI rules*), pengelolaan antrean *order book* secara *in-memory*, pencocokan transaksi berkelanjutan (*continuous matching engine*), pembuatan data transaksi (*trade*), serta penyediaan data pasar real-time.

---

## 🚀 Panduan Menjalankan Layanan (Quick Start)

Jalankan perintah berikut di folder `MATS` untuk memulai secara lokal:

```bash
# 1. Salin variabel lingkungan
cp .env.example .env

# 2. Jalankan container database PostgreSQL lokal & Redis
docker compose up -d

# 3. Unduh & sinkronisasi modul dependensi Go
go mod tidy

# 4. Jalankan aplikasi trading system
go run ./cmd/mats
```

> [!NOTE]
> Endpoint `/health` dapat diakses secara publik. Semua endpoint fungsional lainnya di bawah path `/v1/*` membutuhkan otentikasi header `x-service-token`.

---

## 📡 Daftar API Endpoint

Berikut adalah daftar API Endpoint utama yang disediakan oleh MATS Service:

| Method | Endpoint | Deskripsi | Autentikasi |
| :--- | :--- | :--- | :---: |
| `POST` | `/v1/orders` | Mengajukan order baru (Buy/Sell) ke bursa. | `x-service-token` |
| `PATCH` | `/v1/orders/{orderId}` | Melakukan amend/perubahan volume atau harga order. | `x-service-token` |
| `POST` | `/v1/orders/{orderId}/cancel` | Membatalkan order aktif di bursa. | `x-service-token` |
| `GET` | `/v1/orders/{orderId}` | Mengambil detail status suatu order. | `x-service-token` |
| `POST` | `/v1/admin/sync/bei` | Sinkronisasi master data emiten dari BEI Service. | `x-service-token` |
| `GET` | `/v1/admin/books/{symbol}` | Mengintip struktur *order book* aktif untuk suatu emiten. | `x-service-token` |
| `GET` | `/v1/admin/auction/{symbol}/indicative` | Mengambil harga indikatif IEP & IEV saat sesi lelang pra-pembukaan/penutupan. | `x-service-token` |
| `POST` | `/v1/admin/auction/{symbol}/uncross` | Melakukan pencocokan lelang (*uncrossing order book*). | `x-service-token` |
| `POST` | `/v1/admin/session/status` | Mengubah status sesi pasar (Pre-Open, Open, Closed, dll). | `x-service-token` |
| `POST` | `/v1/admin/session/random-closing` | Mengaktifkan sesi *Random Closing* penutupan pasar. | `x-service-token` |
| `GET` | `/v1/market-data/ws` | Koneksi WebSocket untuk menerima feed market data real-time. | Publik |

> [!TIP]
> MATS mengonsumsi endpoint BEI untuk verifikasi rules dan pelaporan trade capture. Dokumentasi detail spesifikasi kontrak API ekosistem (BEI, MATS, SEKURITAS) secara terpadu dicatat pada [openapi.yaml](../openapi.yaml).

---

## 🧪 Verifikasi & Pengujian Kode

Untuk memverifikasi fungsionalitas dan logika matching engine secara lokal, jalankan unit test berikut:

```bash
go test ./...
```

### Penjelasan Unit Test
Suite integrasi pengujian kami akan membuat simulasi (*mocking*) endpoint BEI dan Sekuritas palsu untuk menguji fungsionalitas:
- Alur pengajuan order sukses dan penolakan order (*reject flow*).
- Siklus pencocokan order (*matching process*).
- Pengiriman capture transaksi final ke BEI.
- Distribusi data pasar ter-update melalui WebSocket snapshot.
