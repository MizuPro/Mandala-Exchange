# 🚀 Panduan Deployment MATS Service

Dokumen ini berisi informasi deployment untuk **MATS Service** agar berjalan dengan aman di server produksi.

---

## 🔒 Konfigurasi Keamanan & Cloudflare Tunnel

Untuk mengamankan API internal bursa efek dari akses luar, ikuti panduan berikut:

1. **Konfigurasi Cloudflare Tunnel:**
   - Salin file konfigurasi `cloudflare-tunnel.example.yml` ke host Cloudflare Tunnel Anda.
   - Ubah hostname `mats.internal.example.com` dengan alamat API internal bursa yang sesuai.
   
2. **Aktifkan Cloudflare Access:**
   - Lindungi hostname tersebut dengan kebijakan **Cloudflare Access** di dasbor Cloudflare Zero Trust.
   - Batasi akses agar hanya alamat IP server Sekuritas atau jaringan VPC bursa yang diizinkan untuk memanggil API MATS.

3. **Keamanan Variabel Lingkungan:**
   - Jangan pernah melakukan *commit* terhadap variabel lingkungan sensitif seperti `MATS_SERVICE_TOKENS`, `BEI_SERVICE_TOKEN`, dan `SEKURITAS_SERVICE_TOKEN` ke dalam sistem *source control* (Git). Gunakan *secret manager* server.

---

## ⚙️ Binding Address Lokal

Untuk performa optimal dan keamanan intranet, kami merekomendasikan binding address lokal berikut pada file konfigurasi/env produksi:

```bash
MATS_HTTP_ADDR=127.0.0.1:8082
```

---

## 📡 Batasan Akses Publik

> [!IMPORTANT]
> Trafik publik dari browser pemain (*player traffic*) hanya diperbolehkan terhubung ke endpoint WebSocket market data:
> ```http
> GET /v1/market-data/ws
> ```
> Seluruh pemanggilan API untuk transaksi, seperti pembuatan order atau pembatalan order (`/v1/orders/*`), **wajib** melalui perantara layanan **Sekuritas** demi menjaga integritas data kustodian, kecukupan saldo dana/saham, dan pencatatan audit log.
