# Analisis Tech Stack & Feasibility: 300–2000 Bot di Laptop Lokal

> **Status**: Analisis feasibility. Angka normatif, canonical workload, dan pass/fail gate mengikuti `BOT_PRD.md` serta `BOT_PERFORMANCE_TEST_PLAN.md`.

**Konteks Sistem**: Intel i5-10300H (4C/8T, 2.5–4.5GHz), 16GB RAM  
**Service yang Sudah Berjalan**: BEI (Node.js), MATS (Go), Sekuritas Backend (Node.js), Sekuritas Frontend (React/Vite), 4× PostgreSQL termasuk BOT DB, Redis, Docker/WSL, browser, dan IDE

---

## 1. Estimasi Resource Sistem yang Sudah Berjalan

Sebelum membahas bot, kita perlu tahu sisa resource yang tersedia di laptop Anda:

| Service | RAM Est. | CPU (idle) | CPU (peak) |
|---|---|---|---|
| BEI Service (Fastify TS) | 120–180 MB | 0–2% | 5–15% |
| MATS Engine (Go) | 50–100 MB | 1–5% | 10–30% |
| Sekuritas Backend (Fastify TS) | 150–250 MB | 1–3% | 10–20% |
| Sekuritas Frontend (Vite preview) | 100–200 MB | 0–1% | 2–5% |
| PostgreSQL BEI (port 5441) | 80–150 MB | 0–2% | 5–10% |
| PostgreSQL MATS (port 5434) | 80–150 MB | 0–3% | 8–20% |
| PostgreSQL Sekuritas (port 5432) | 80–150 MB | 0–2% | 5–15% |
| Redis | 20–50 MB | 0–1% | 2–5% |
| OS + background (Windows) | 2.0–3.0 GB | 5–10% | — |
| **TOTAL EXISTING** | **~3.5–5 GB** | **~10–25%** | — |

Estimasi di atas belum memasukkan seluruh overhead Docker/WSL, browser, IDE, cache database, dan peak allocation. Budget normatif total stack adalah maksimal 12 GB; sisa resource harus dibuktikan melalui environment manifest dan benchmark, bukan diasumsikan.

---

## 2. Kesalahpahaman Umum: "2000 Bot = 2000 Proses"

> ❌ **SALAH**: 2000 bot ≠ 2000 thread ≠ 2000 proses

Ini adalah konsep terpenting yang harus dipahami agar tidak takut membuat 2000 bot.

**Semua 2000 bot berjalan dalam 1 proses aplikasi tunggal** sebagai concurrent tasks/coroutines. Cara kerjanya:

```
Satu proses BOT Service
│
├── Bot #1 (noise trader BBCA)  ← async sleep 8 menit
├── Bot #2 (momentum TLKM)      ← async sleep 3 menit
├── Bot #3 (market maker GOTO)  ← refresh setiap 30 detik
├── Bot #4 (bandar BBRI)        ← async sleep 2 jam
├── ...
├── Bot #1999 (retail ASII)     ← async sleep 45 menit
└── Bot #2000 (contrarian UNVR) ← async sleep 12 menit
```

Pada satu momen (per milidetik), hanya **sangat sedikit** bot yang benar-benar melakukan komputasi. Mayoritas sedang **idle / menunggu timer**.

---

## 3. Berapa Banyak Bot yang Benar-Benar Aktif Secara Bersamaan?

Jika setiap bot rata-rata mengeksekusi logika trading (cek harga & submit order) setiap 10 menit, dan proses itu memakan waktu komputasi 2 milidetik:

```
Rasio waktu CPU aktif per bot = 2 ms / 600,000 ms = 0.00033%

Dari 2000 bot:
  Rata-rata bot komputasi serentak = 2000 × 0.00033% ≈ 0.006 bot
```

**Realitanya: CPU hampir tidak merasakan beban konstan.** Beban hanya terasa jika ada lonjakan (*burst*) di mana banyak bot bereaksi terhadap event yang sama (misal harga drop mendadak). Bahkan saat *burst*, mengeksekusi 100 bot secara konkuren hanya butuh waktu sekian milidetik.

Yang dibutuhkan 2000 bot secara konstan hanyalah **RAM** untuk menyimpan *state* (posisi, cash, config).

---

## 4. Estimasi RAM per Bot

| Data yang Disimpan per Bot (In-Memory) | Ukuran Estimasi |
|---|---|
| Konfigurasi bot (struct/object) | ~1–2 KB |
| State portfolio (posisi, kas) | ~0.5–1 KB |
| History keputusan terakhir | ~5–10 KB |
| Timer/scheduler handle | ~0.1–0.5 KB |
| **Total state per bot** | **~7–15 KB** |

```
2000 bot × 15 KB             = ~30 MB   (state unik bot)
Shared market data cache     = ~20 MB   (order book untuk semua bot)
HTTP & WS connection pool    = ~10 MB
Runtime overhead (Go/Node)   = ~30–80 MB
───────────────────────────────────────────
RAW STATE/RUNTIME MINIMUM    ≈ 90–140 MB
OPERATIONAL BUDGET BOT       ≤ 500 MB
```

**Kesimpulan RAM**: Raw state agent memang kecil, tetapi snapshot, queue, event buffer, log batch, metrics, database client, dan GC menaikkan working set. Estimasi operasional konservatif adalah 250–500 MB untuk BOT Service. Total stack tetap menjadi batas utama.

---

## 5. Perbandingan Tech Stack untuk Bot

| Kriteria | **Go (Golang)** | **Node.js (TypeScript)** | **Python** |
|---|---|---|---|
| **Memory per coroutine** | **~2–8 KB (Goroutine)** | ~10–50 KB (Promise) | ~50–100 KB |
| **RAM untuk 2000 task** | **~5–20 MB** | ~20–100 MB | ~100–200 MB |
| **CPU efficiency** | **Sangat Tinggi (Compiled)** | Tinggi (JIT) | Sedang |
| **True Parallelism** | **Ya (Semua Core CPU dipakai)** | Terbatas (Single-thread event loop) | Tidak (GIL) |
| **Konsistensi Codebase** | Sama dengan MATS | Sama dengan Sekuritas & BEI | Baru |
| **WebSocket / HTTP** | Sangat mumpuni | Sangat mumpuni | Memadai |

### ❌ Python
Sebaiknya hindari Python untuk kasus ini. GIL (*Global Interpreter Lock*) membuatnya kurang ideal untuk sistem highly-concurrent dengan ribuan task, dan akan memakan RAM lebih besar.

### 🟡 Node.js (TypeScript)
Bisa digunakan, **TETAPI**:
Karena Node.js menggunakan *single-threaded event loop*, jika ada momen di mana 2000 bot "terbangun" bersamaan (misalnya saat market baru buka di jam 09:00), event loop bisa mengalami *block/lag*. Node.js sangat bagus untuk I/O, tetapi jika ada komputasi algoritma (misal bot value investor menghitung valuasi, atau bandar menghitung distribusi), 1 thread bisa kewalahan.
*Bisa diakali dengan Worker Threads, tapi menambah kompleksitas.*

### 🟢 Rekomendasi Utama: Go (Golang)
Sangat disarankan menggunakan **Go**.
- **Goroutines**: Fitur andalan Go. Anda bisa me-*spawn* 2000 goroutine dengan biaya RAM hanya beberapa MB.
- **M-N Scheduler**: Go secara otomatis mendistribusikan 2000 goroutine tersebut ke 8 Thread CPU (i5-10300H) secara seimbang.
- **Performa I/O**: Komunikasi ke API Sekuritas (HTTP) dan MATS (WebSocket) sangat efisien tanpa menahan eksekusi CPU.
- **Konsistensi**: MATS Engine Anda sudah dibuat dengan Go, artinya struktur folder, library, dan pola arsitekturnya bisa saling berbagi.

---

## 6. Apakah Laptop Anda (i5-10300H, 16GB) Sanggup 2000 Bot?

### **MUNGKIN UNTUK STRESS TEST; BUKAN DEFAULT TANPA BENCHMARK**.

Target default adalah 300–500 bot. Skala 1.000 adalah extended test dan 2.000 adalah maximum stress test. Correctness wajib tetap lulus pada seluruh skala, sedangkan performance gate default wajib lulus pada 300–500 bot.

### Ancaman Bottleneck Sebenarnya: Sekuritas API
Beban terberat tidak ada pada BOT Service saat "memikirkan" strategi, melainkan saat **2000 bot mengirim HTTP request secara bersamaan** ke backend Sekuritas (`POST /api/v1/orders`).

Jika 500 bot tiba-tiba submit order di detik yang sama:
- Sekuritas Backend (Node.js) akan menerima 500 request berbarengan.
- Sekuritas DB (Postgres) akan menerima 500 transaksi (reserve cash, reserve saham, insert order).
- MATS (Go) akan menerima 500 order via HTTP.

Inilah yang bisa membuat laptop lag atau request timeout.

---

## 7. Strategi Arsitektur Menghadapi 2000 Bot

Untuk memastikan laptop Anda tetap "dingin" dan tidak hang, BOT Service (di Go) harus mengimplementasikan pola ini:

### A. Global Rate Limiter & Order Queue
Bot tidak boleh mengirim HTTP request langsung saat itu juga. Mereka menaruh pesanan di sebuah "pipa" (*channel* dalam Go), dan hanya ada beberapa "kurir" (*worker*) yang mengirimnya ke Sekuritas.

```go
orderQueue := make(chan OrderRequest, 5_000)
limiter := rate.NewLimiter(rate.Every(200*time.Millisecond), 100) // 300/menit, burst 100

for i := 0; i < 10; i++ {
    go func() {
        for req := range orderQueue {
            if err := limiter.Wait(ctx); err != nil {
                return
            }
            submitToSekuritas(req)
        }
    }()
}
```

Implementasi final memakai priority queue, per-action TTL, hard breaker 600/menit, dan stable `client_order_id` sesuai PRD; snippet hanya memperlihatkan global limiter.

### B. Single WebSocket Connection untuk Market Data
Jangan biarkan 2000 bot melakukan koneksi WebSocket ke MATS masing-masing! 
- BOT Service hanya buka **1 koneksi WebSocket** ke MATS.
- Event memperbarui shared immutable snapshot per symbol. Bot membaca snapshot saat scheduler mengevaluasi strategi; event tidak disalin ke 2000 channel/variabel agent.

### C. Staggered Startup (Tidak Bangun Bersamaan)
Saat menyalakan BOT Service, jangan hidupkan 2000 bot di milidetik yang sama.
Beri jeda *startup*, misalnya 10 milidetik antar bot. (Total butuh 20 detik untuk menyalakan 2000 bot). Ini mencegah CPU *spike* hingga 100% saat aplikasi baru jalan.

### D. Audit Log via Batch Insert
Setiap keputusan bot akan disimpan ke database (`bot_decision_logs`). Jangan lakukan `INSERT` setiap kali bot bertindak. Kumpulkan di memori, lalu simpan sekaligus (misalnya 100 log sekali insert tiap 5 detik).

---

## 8. Kesimpulan & Roadmap Implementasi

**Tech Stack**: **Go (Golang)**. Ringan, multi-core secara otomatis, dan ramah memory.
**Kapasitas**: 300–500 bot adalah target default, 1.000 extended test, dan 2.000 stress test. Kelayakan final ditentukan oleh `BOT_PERFORMANCE_TEST_PLAN.md`.

### Langkah Implementasi Bertahap:

1. **Tahap 1 (Infrastruktur)**: Buat skeleton BOT Service di Go, siapkan koneksi ke MATS (WS) dan Sekuritas (HTTP).
2. **Tahap 2 (Proof of Concept)**: Buat 10 bot dengan strategi *Noise Trader* sederhana. Validasi apakah order sukses masuk dan match.
3. **Tahap 3 (Scaling Pertama)**: Naikkan menjadi 100 bot. Monitor penggunaan RAM dan CPU laptop Anda. Monitor kecepatan respon Sekuritas Backend.
4. **Tahap 4 (Default Gate)**: Naikkan ke 300 lalu 500 dan lulus canonical workload, failure injection, serta soak test.
5. **Tahap 5 (Extended/Stress)**: Naikkan ke 1.000 lalu 2.000 tanpa mengubahnya menjadi default runtime.

Dengan pendekatan terstruktur ini, kapasitas aman ditetapkan dari data benchmark, bukan estimasi state agent semata.
