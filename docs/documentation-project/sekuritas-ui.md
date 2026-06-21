# SEKURITAS Frontend (UI & State Management)

## Deskripsi Umum
Frontend dari **SEKURITAS** adalah aplikasi Single Page Application (SPA) berbasis React (Vite, TypeScript, Tailwind CSS) yang menyediakan antarmuka interaktif bagi investor/nasabah. Aplikasi ini dirancang untuk beroperasi secara *real-time*, menampilkan pergerakan harga pasar (Market Data) dan memperbarui status pesanan serta portofolio seketika tanpa perlu memuat ulang halaman (*refresh*).

## Komponen Utama & Logika

### 1. Global State Management (Zustand Store)
- **File**: [useStore.ts](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/SEKURITAS/frontend/src/store/useStore.ts)
- **Fungsi**: Bertindak sebagai *single source of truth* bagi seluruh komponen UI. Store ini menyimpan dan mengelola status untuk:
  - Otentikasi (`user`, `token`).
  - Portofolio, pesanan (Orders), riwayat perdagangan, notifikasi.
  - *Market State* secara real-time (`connected`, `sessionStatus`, `lastPrices`, `depth`, `trades`).
- **Real-Time Handlers**:
  - `applyMarketEvent(event)`: Digunakan oleh koneksi WebSocket (*Market WS*) untuk memperbarui daftar harga terakhir, *depth snapshot* (Order Book), dan rentetan perdagangan (*tape*) begitu ada aliran data masuk.
  - `applyUserEvent(event)`: Digunakan oleh koneksi WebSocket spesifik pengguna untuk mendengarkan pembaruan asinkron dari pesanan, misalnya mengubah status `pending` menjadi `filled`.

### 2. Antarmuka Perdagangan Saham (Market Detail & Order Entry)
- **File**: [MarketDetail.tsx](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/SEKURITAS/frontend/src/pages/MarketDetail.tsx)
- **Fungsi**: Menyajikan tampilan terpadu sebuah saham (misal: BBCA).
- **Fitur Khusus**:
  - **Kalkulasi BEI Tick Size**: Memiliki helper internal (`getTickSize`, `roundUpToTick`, `roundDownToTick`) untuk menyesuaikan tombol `+` dan `-` saat memasukkan harga limit berdasarkan fraksi harga resmi Bursa Efek Indonesia (BEI).
  - **Batas ARA & ARB**: Memvalidasi entri harga pengguna agar tidak melebihi *Auto Rejection Atas* (ARA) dan *Auto Rejection Bawah* (ARB).
  - **Integrasi Store**: Berinteraksi langsung dengan *Zustand store* untuk meluncurkan `placeOrder`, memuat *candlesticks*, serta membaca data *live depth* secara reaktif.

### 3. Komponen Panel Utama (Dashboard)
- Aplikasi ini menggunakan sistem berbasis tab atau panel untuk merapikan informasi yang sangat padat. Beberapa komponen esensial meliputi:
  - **Portfolio Panel**: Meringkas saldo dana *Available*, *Reserved*, *Pending* dan posisi saham yang sedang dimiliki.
  - **Market Panel / Leaderboard**: Memberikan pandangan pasar yang lebih luas dan rangking pemain (jika dalam mode simulasi).

## Alur Kerja (Workflow)
1. **Inisialisasi**: Saat aplikasi dimuat, *store* akan melakukan hidrasi sesi (`hydrateSession`), mengambil saldo portofolio, lalu membentuk dua koneksi WebSocket (satu ke *Market WS* dan satu ke *User WS* melalui proxy gateway backend).
2. **Streaming Data**: Begitu WebSocket Market terhubung, fungsi `applyMarketEvent` akan dipanggil berkali-kali setiap detiknya oleh *handler* WS, menyebabkan UI seperti Order Book re-render secara efisien.
3. **Pemesanan**: Saat pengguna menekan "Beli", UI memanggil fungsi `placeOrder` di store, yang mengirim HTTP POST ke backend. Backend akan membalas secara sinkron.
4. **Pembaruan Asinkron**: Jika pesanan tereksekusi di mesin MATS, MATS menembak webhook backend, backend menyiarkan *event* spesifik pengguna lewat WS, yang akhirnya ditangkap oleh `applyUserEvent` di *frontend* untuk memutakhirkan label status dari "Pending" menjadi "Filled" beserta merilis notifikasi *toast*.

## Daftar File yang Terlibat
- [useStore.ts](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/SEKURITAS/frontend/src/store/useStore.ts) - Pusat saraf *state management* dan integrasi API/WebSocket.
- [MarketDetail.tsx](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/SEKURITAS/frontend/src/pages/MarketDetail.tsx) - Halaman detail saham dan kontrol logika form pesanan yang kompleks.
