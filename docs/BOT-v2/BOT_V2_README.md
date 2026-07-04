# BOT-v2 Agent-Based Simulation - README

Versi: 1.0
Tanggal: 2026-07-03
Status: Konsep final awal untuk implementasi bertahap

## 1. Tujuan Paket Dokumen

Paket dokumen ini merangkum konsep BOT-v2 untuk Mandala Exchange sebagai Agent-Based Simulation berbasis Go. Konsep ini dibuat untuk menggantikan konsep BOT awal yang terlalu kompleks dan terlalu banyak dokumen, sehingga lebih aman untuk dieksekusi bertahap.

BOT-v2 tidak dimulai dari strategi bot yang rumit. BOT-v2 dimulai dari memperjelas ekosistem layanan utama:

1. BEI sebagai sumber aturan bursa, emiten, sesi, IPO, corporate action, news, fair value, dan market regime.
2. MATS sebagai matching engine dan market data source.
3. Sekuritas sebagai jalur resmi akun, saldo, posisi, order, dan settlement.
4. BOT-v2 sebagai simulator agent yang bertindak seperti investor biasa.

## 2. Keputusan Final Utama

| Topik | Keputusan |
|---|---|
| Runtime BOT | Go language |
| Model simulasi | Agent-Based Simulation |
| Order BOT | Hanya lewat Sekuritas |
| Direct order ke MATS | Tidak boleh |
| Direct mutation ke BEI | Tidak boleh, kecuali lewat alur resmi seperti genesis via Sekuritas |
| News dan Fair Value saat ini | Module di BEI/Admin Bursa |
| News dan Fair Value nanti | Bisa dipisah menjadi service baru |
| Fair value | Input manual admin dulu |
| Fair value dilihat player | Ya |
| Fair value dilihat bot | Ya |
| News mengubah harga langsung | Tidak |
| Harga berubah karena | Order player dan BOT yang match di MATS |
| Jumlah bot registered | Sampai 2000 |
| Jumlah bot aktif awal | Disesuaikan jumlah saham |
| 3 saham awal | MNDL, NUSA, BARA |
| IPO | Dideteksi dinamis dari BEI/Sekuritas |
| IPO ARA | Peluang cukup tinggi untuk IPO tertentu, tetapi tidak pasti dan tidak seragam |
| Bot bangkrut | Boleh, diberi status bankrupt dan tidak ikut bermain jika sudah tidak punya cash dan saham |
| Session aktif order | Hanya continuous dan auction |
| Order di luar continuous/auction | Tidak boleh |

## 3. Struktur File

1. `BOT_V2_CONCEPT.md`
   - Konsep utama BOT-v2, arsitektur, session, market regime, dan prinsip desain.

2. `BOT_V2_SERVICE_BOUNDARY.md`
   - Batas tanggung jawab BEI, MATS, Sekuritas, News/Fair Value, dan BOT.

3. `BOT_V2_AGENT_BEHAVIOR.md`
   - Jenis bot, komposisi populasi, distribusi modal, reaksi ke news, fair value, IPO, ARA/ARB, dan bankruptcy.

4. `BOT_V2_IMPLEMENTATION_PLAN.md`
   - Rencana implementasi bertahap dari service readiness sampai stress test 2000 bot.

## 4. Prinsip Paling Penting

BOT-v2 harus menjaga prinsip berikut:

1. Bot adalah investor simulasi, bukan cheat engine.
2. Bot hanya boleh bereaksi pada data publik yang juga dapat dilihat player.
3. Bot tidak boleh mengetahui portfolio player, pending order player, atau future announcement.
4. Semua order bot harus lewat Sekuritas.
5. News dan fair value tidak mengubah harga langsung.
6. ARA/ARB bukan output default, melainkan output kondisi ekstrem.
7. IPO boleh sering hype, tetapi tidak selalu ARA dengan pola yang sama.
8. Market harus hidup, tetapi tidak boleh selalu bergerak ekstrem.
9. Bot boleh rugi dan bangkrut.
10. Implementasi harus bertahap, bukan langsung 2000 bot dan semua strategi.

## 5. Rekomendasi Penggunaan Dokumen

Gunakan dokumen ini sebagai acuan implementasi awal. Jangan langsung menambahkan dokumen terlalu banyak. Jika nanti BOT-v2 sudah berjalan stabil, barulah dibuat dokumen tambahan seperti API contract detail, performance benchmark, atau calibration report.
