# 🚀 Panduan Deployment BEI Service

Dokumen ini berisi instruksi detail untuk mendeploy **BEI Service** baik untuk lingkungan produksi maupun pengujian lokal menggunakan Cloudflare Tunnel.

---

## 📋 Langkah-Langkah Deployment

Ikuti langkah-langkah berikut secara berurutan untuk memastikan BEI Service berjalan dengan benar:

1. **Jalankan Database PostgreSQL:**
   Jalankan container Postgres menggunakan Docker Compose:
   ```bash
   docker compose up -d
   ```

2. **Jalankan Migrasi & Pengisian Data (Seeding):**
   Terapkan struktur tabel ke database dan masukkan data konfigurasi awal:
   ```bash
   npm run db:migrate && npm run db:seed
   ```

3. **Build & Jalankan Aplikasi:**
   Kompilasi TypeScript ke JavaScript murni, lalu jalankan aplikasinya:
   ```bash
   npm run build
   npm run start
   ```

---

## 🔒 Integrasi Cloudflare Tunnel

Untuk mengekspos layanan ke internet secara aman tanpa membuka port publik:

- Salin file contoh konfigurasi terlampir `cloudflare-tunnel.example.yml` ke host Cloudflare Tunnel Anda.
- Konfigurasikan sub-domain atau hostname internal bursa efek Anda.
- Proteksi endpoint tersebut menggunakan **Cloudflare Access** guna membatasi siapa saja yang dapat mengakses domain tersebut secara publik.

> [!IMPORTANT]
> Selalu aktifkan validasi `x-service-token` di sisi kode server BEI meskipun Anda sudah menggunakan proteksi Cloudflare Access di depan. Hal ini penting untuk mencegah adanya akses tidak terotorisasi dari dalam jaringan internal bursa (*intranet*) yang berhasil mem-bypass proxy eksternal.
