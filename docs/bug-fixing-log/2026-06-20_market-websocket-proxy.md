# Bug Fixing Log — Market Session Websocket Proxy

**Tanggal:** 2026-06-20
**Modul/Fitur:** Market Session & WebSocket State Synchronization
**Mode Analisis:** deep
**Dikerjakan oleh:** Agent + User

---

## 🐛 Masalah yang Ditemukan

### 1. Pesan WebSocket Biner Menggagalkan Parsing JSON di Frontend
- **File:** `SEKURITAS/backend/src/services/market-ws-proxy.ts`
- **Deskripsi:** Library `ws` di backend menerima frame text dari upstream MATS dalam bentuk tipe data `Buffer`. Ketika dibroadcast langsung dengan `client.send(data)`, library mengirimkannya sebagai "Binary Frame" secara default. Di sisi frontend, event data diterima sebagai objek `Blob`, dan ketika dieksekusi ke `JSON.parse([object Blob])` muncul exception (yang sayangnya di-*silence* oleh try-catch). Akibatnya, pembaruan real-time krusial seperti transisi sesi bursa (e.g., *pre_open* ke *continuous*) gagal mengubah UI karena datanya dibuang.
- **Severity:** Critical

### 2. Polling HTTP Sesi Pasar Redundan
- **File:** `SEKURITAS/frontend/src/pages/Dashboard.tsx`
- **Deskripsi:** Karena menganggap WebSocket belum reliabel, frontend sebelumnya diset untuk melakukan HTTP polling memanggil `fetchMarketSession()` setiap 2 detik. Hal ini sangat membebani lalu lintas data dan tidak efisien karena fungsi *push* WebSocket sebenarnya sudah didesain untuk ini.
- **Severity:** Medium

### 3. Redundansi Pemanggilan API Order Akibat Polling Bertumpuk
- **File:** `SEKURITAS/frontend/src/pages/ActivityOrder.tsx`
- **Deskripsi:** Saat user membuka halaman Activity, dua polling `fetchOrders()` dari `Dashboard.tsx` (sebagai layout induk) dan dari `ActivityOrder.tsx` berjalan beriringan setiap 5 detik dengan jeda offset waktu tertentu, memicu pemanggilan redundan API ke `/api/v1/orders`.
- **Severity:** Low

---

## ✅ Solusi yang Dikerjakan

### 1. Pesan WebSocket Biner Menggagalkan Parsing JSON di Frontend
- **Perubahan yang Dilakukan:** Mengubah argumen callback `socket.on("message", (data, isBinary) => ...)` untuk menangkap tipe frame asli dari upstream, dan menembuskan variabel `isBinary` tersebut ke dalam fungsi broadcast sehingga eksekusi akhir menjadi `client.send(data, { binary: isBinary })`.
- **File yang Dimodifikasi:** `SEKURITAS/backend/src/services/market-ws-proxy.ts`
- **Catatan:** Ini langsung menyelesaikan akar permasalahan di mana `fetchMarketSession` gagal berjalan *real-time*.

### 2. Polling HTTP Sesi Pasar Redundan
- **Perubahan yang Dilakukan:** Menghapus sepenuhnya blok interval 2 detik untuk `fetchMarketSession()`. Frontend kini hanya me-load satu kali saat awal, lalu 100% mendengarkan pembaruan (`session_state` dan `session_timer`) via WebSocket.
- **File yang Dimodifikasi:** `SEKURITAS/frontend/src/pages/Dashboard.tsx`
- **Catatan:** Menghemat *bandwidth* secara drastis dengan menyerahkan tugas *update* ke jembatan proxy WebSocket.

### 3. Redundansi Pemanggilan API Order Akibat Polling Bertumpuk
- **Perubahan yang Dilakukan:** Menghapus interval 5 detik dari *hook* `useEffect` di `ActivityOrder.tsx`. Pengambilan data dibiarkan satu kali (on mount), dan *auto-refresh* akan di-handle sepenuhnya oleh state global yang dipanggil berkala oleh `Dashboard.tsx`.
- **File yang Dimodifikasi:** `SEKURITAS/frontend/src/pages/ActivityOrder.tsx`
- **Catatan:** Memastikan efisiensi dengan sentralisasi *fetcher* pada layout induk untuk semua rute anak yang terpasang di bawahnya.

---

## 📚 Pelajaran yang Dipetik

1. Saat membangun *proxy layer* menggunakan protokol WebSocket (khususnya library `ws` di Node.js), sangat penting untuk memerhatikan flag `isBinary`. Meneruskan tipe variabel `Buffer` mentah secara langsung tanpa kontrol flag bisa mengakibatkan paket terbaca sebagai *Blob*/*Binary* pada klien web standar.
2. Jangan melakukan *silence exception* (`try { ... } catch {}` kosong) pada parsing data krusial dari server (terutama blok JSON.parse di listener WebSocket). Praktik *silent failure* akan menyembunyikan akar masalah dan membuat proses *debugging* menjadi sangat sulit.
3. Hindari pembuatan interval `setInterval` identik yang mengakses Global State yang sama dari banyak komponen hierarkis (*parent-child rendering*). Delegate *timer-based polling* di top-level provider/layout untuk mencegah redundansi API call di sistem.
