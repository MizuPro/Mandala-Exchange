# Panduan Arsitektur & Peta File Frontend Sekuritas

Dokumen ini adalah peta panduan (directory mapping guide) untuk codebase frontend Mandala Sekuritas (**SEKURITAS/frontend**). Tujuannya agar Anda dapat menemukan file yang tepat dengan cepat saat ingin memodifikasi fitur atau visual tertentu tanpa harus menelusuri seluruh direktori kode.

---

## 1. Struktur Folder Utama (`src/`)

```text
src/
├── api/          # Integrasi API HTTP Client
├── components/   # Komponen UI Reusable (Portofolio, Form Order, dll)
├── config/       # Konfigurasi Endpoints & Environment
├── pages/        # Halaman Utama Aplikasi (Dashboard, Detail Saham, dll)
├── store/        # Zustand Store (State Management Global)
├── types/        # Definisi TypeScript Types
└── index.css     # CSS Utility & Global Variables (Base Color & Themes)
```

---

## 2. Peta Halaman Utama (`src/pages/`)

Jika Anda ingin mengubah visual atau alur logika dari halaman tertentu, cari file `.tsx` yang bersangkutan di sini:

| Nama Halaman | Lokasi File | Tanggung Jawab & Deskripsi Fitur |
| :--- | :--- | :--- |
| **Landing Page** | [LandingPage.tsx](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/SEKURITAS/frontend/src/pages/LandingPage.tsx) | Halaman muka Mandala Sekuritas, memuat copywriting, daftar fitur, dan visualisasi layout isometrik 3D. Styling kustom ada di [LandingPage.css](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/SEKURITAS/frontend/src/pages/LandingPage.css). |
| **Login & Register** | [Login.tsx](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/SEKURITAS/frontend/src/pages/Login.tsx) | Layar autentikasi JWT token (Masuk & Daftar Akun). Styling ada di [Login.css](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/SEKURITAS/frontend/src/pages/Login.css). |
| **Verifikasi Email** | [VerifyEmail.tsx](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/SEKURITAS/frontend/src/pages/VerifyEmail.tsx) | Layar OTP verifikasi email setelah pendaftaran akun baru. |
| **Dashboard Layout** | [Dashboard.tsx](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/SEKURITAS/frontend/src/pages/Dashboard.tsx) | **Layout wrapper utama**. Menyediakan sidebar navigasi, menginisiasi koneksi WebSocket pasar global, serta memuat Modal Deposit/Withdrawal Dana RDN. |
| **Dashboard Home** | [DashboardHome.tsx](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/SEKURITAS/frontend/src/pages/DashboardHome.tsx) | Layar beranda setelah login. Menampilkan ringkasan portofolio cepat, grafik indeks bursa (MDX), watchlist saham favorit, dan feed berita. |
| **Detail Saham** | [MarketDetail.tsx](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/SEKURITAS/frontend/src/pages/MarketDetail.tsx) | Halaman detail trading saham (chart lilin, orderbook side-by-side premium, running trades, profil emiten, dan laporan fundamental). |
| **Riwayat Order** | [ActivityOrder.tsx](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/SEKURITAS/frontend/src/pages/ActivityOrder.tsx) | Halaman yang menampilkan seluruh daftar order milik user (Antrean Aktif, Sukses Terpenuhi, Amend, dan Cancel). |
| **Settings** | [SettingsPage.tsx](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/SEKURITAS/frontend/src/pages/SettingsPage.tsx) | Pengaturan akun user: edit profil, ganti password, detail akun bank terdaftar, dan informasi data nomor RDN/SRE/SID. |
| **Admin Dashboard** | [AdminDashboard.tsx](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/SEKURITAS/frontend/src/pages/AdminDashboard.tsx) | Konsol khusus admin/operator untuk mengontrol status sesi perdagangan bursa (Open/Halt/Resume/Suspensi saham). |

---

## 3. Peta Komponen UI Reusable (`src/components/`)

Komponen-komponen spesifik yang digunakan di dalam berbagai halaman dashboard:

| Nama Komponen | Lokasi File | Deskripsi & Kegunaan |
| :--- | :--- | :--- |
| **Portfolio Detail** | [Portfolio.tsx](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/SEKURITAS/frontend/src/components/Portfolio.tsx) | Menampilkan rincian saldo kas RDN, daftar kepemilikan saham (Lot, Average Price, Realized & Unrealized Profit/Loss), serta grafik alokasi aset. |
| **Order Entry** | [OrderEntry.tsx](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/SEKURITAS/frontend/src/components/OrderEntry.tsx) | Form transaksi Beli/Jual saham (limit/market order) lengkap dengan kalkulasi biaya fee transaksi (broker fee, clearing fee, levy, PPN/PPh). |
| **Daftar Saham** | [MarketPanel.tsx](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/SEKURITAS/frontend/src/components/MarketPanel.tsx) | Tabel daftar seluruh saham yang listing di BEI beserta info harga dan pergerakan harian (digunakan di halaman Market/Dashboard). |
| **Leaderboard** | [Leaderboard.tsx](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/SEKURITAS/frontend/src/components/Leaderboard.tsx) | Menampilkan peringkat return keuntungan trading antar pengguna Mandala. |
| **Informasi Rekening** | [AccountProfile.tsx](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/SEKURITAS/frontend/src/components/AccountProfile.tsx) | Panel kecil info saldo RDN, nomor rekening bank penampung, SID, SRE, dan RDN. |
| **Notifikasi** | [Notifications.tsx](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/SEKURITAS/frontend/src/components/Notifications.tsx) | Notifikasi real-time (popover) ketika order matched, rejected, atau dana masuk. |
| **Penyelesaian Saham** | [SettlementPanel.tsx](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/SEKURITAS/frontend/src/components/SettlementPanel.tsx) | Panel informasi kliring penyelesaian dana & saham (T+2 settlement). |

---

## 4. State Global & Integrasi API

- **State Store Global (Zustand)**: **[useStore.ts](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/SEKURITAS/frontend/src/store/useStore.ts)**
  - *Gunakan file ini jika*: Anda ingin melihat cara data dikelola secara global, mengubah cara penanganan WebSocket event (`applyMarketEvent`), atau memodifikasi method API call (seperti `placeOrder`, `cancelOrder`, `depositFunds`, dll).
- **HTTP Client Wrapper**: **[client.ts](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/SEKURITAS/frontend/src/api/client.ts)**
  - *Gunakan file ini jika*: Ingin menambah header custom, memodifikasi base fetch logic, atau mengubah mekanisme handling token kedaluwarsa.
- **Konfigurasi Server**: **[endpoints.ts](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/SEKURITAS/frontend/src/config/endpoints.ts)**
  - *Gunakan file ini jika*: Ingin mengganti port default backend (`3002`) atau alamat WebSocket server.

---

## 5. Sistem Warna & Desain (CSS)

- **Main Theme (Base Color)**: **[index.css](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/SEKURITAS/frontend/src/index.css)**
  - Mandala Sekuritas menggunakan skema warna **Dark Mode Native**.
  - Jika Anda ingin mengubah warna tema aplikasi (merah aksen, navy blue, background panel gelap), Anda bisa menyesuaikan CSS variables pada file ini.
