# Implementation Plan - Perbaikan Persistensi Harga, ARA/ARB, dan Tick Size

## Ringkasan Analisis

Mode analisis: deep.

Target masalah:
- Harga saham dan ARA/ARB kembali ke nilai awal setelah server dibuka ulang.
- Seed MNDL memakai harga `315`, padahal tidak valid untuk tick size yang berlaku.
- Bug lain yang berkaitan dengan kesinambungan harga, market summary, dan validasi fraksi harga.

Kesimpulan utama:
- Masalah reset harga di development memang dapat dibuktikan dari kode. `start-all.bat` menjalankan seed BEI setiap start development, dan seed BEI meng-overwrite `reference_price` dan `previous_close`.
- Last price intraday di MATS/Sekuritas masih berbasis memory cache. Jika proses mati/restart sebelum sesi ditutup dan market summary BEI belum menjadi sumber state, UI bisa fallback ke `previous_close`.
- Seed MNDL `previous_close = 315` invalid karena untuk rentang harga 200-499 tick size-nya adalah 2.

## Confirmed Bug 1 - Seed development mengembalikan harga dan ARA/ARB ke nilai awal

Lokasi bukti:
- `start-all.bat:57-58`
- `BEI/src/db/seed.ts:31-36`
- `MATS/internal/rules/cache.go:206-210`
- `MATS/internal/rules/cache.go:388-406`

Detail:
- `start-all.bat` menjalankan `npm run db:seed` setiap mode `development`.
- Seed BEI memakai `ON CONFLICT (symbol) DO UPDATE SET reference_price = excluded.reference_price, previous_close = excluded.previous_close`.
- Akibatnya setiap start ulang development, `listed_securities.reference_price` dan `previous_close` untuk MNDL/NUSA/BARA dikembalikan ke nilai seed.
- ARA/ARB di MATS dihitung dari `security.ReferencePrice`, jadi reset `reference_price` membuat ARA/ARB ikut kembali ke nilai awal.

Rencana fix:
1. Ubah seed listed securities agar tidak meng-overwrite harga dinamis saat symbol sudah ada.
2. Tetap izinkan seed memperbarui metadata statis seperti nama, board, sector, shares outstanding, status, dan mechanism jika memang perlu.
3. Untuk `reference_price` dan `previous_close`, gunakan strategi konservatif:
   - saat insert baru: pakai nilai seed;
   - saat conflict: jangan update kedua kolom tersebut, atau update hanya jika nilai existing NULL/0.
4. Tambahkan opsi reset eksplisit untuk development, misalnya script `db:seed:reset-market` atau env flag `SEED_RESET_MARKET=true`, agar reset tetap bisa dilakukan saat memang dibutuhkan.

## Confirmed Bug 2 - Harga terakhir intraday hilang setelah restart proses sebelum sesi ditutup

Lokasi bukti:
- `MATS/cmd/mats/main.go:71`
- `MATS/internal/marketdata/summary.go:9-15`
- `MATS/internal/marketdata/summary.go:18-40`
- `MATS/internal/orders/service.go:190-196`
- `MATS/internal/orders/service.go:364-370`
- `SEKURITAS/backend/src/services/market-ws-proxy.ts:9-12`
- `SEKURITAS/frontend/src/store/useStore.ts:558-565`
- `SEKURITAS/frontend/src/components/MarketPanel.tsx:97-98`
- `SEKURITAS/frontend/src/pages/MarketDetail.tsx:208-209`

Detail:
- MATS memang menyimpan trade ke persistence store saat match.
- Namun `SummaryStore` MATS dibuat baru di memory setiap proses start dan hanya diisi oleh trade baru.
- `Recover()` MATS hanya memuat open orders ke matching engine, tidak membangun ulang `SummaryStore` dari trade yang sudah tersimpan.
- Proxy WebSocket Sekuritas juga menyimpan `lastPriceCache` dan `summaryCache` di memory proses.
- Saat proses restart, frontend akan kehilangan event `last_price` terakhir dan fallback ke `previous_close` dari securities.

Rencana fix:
1. Tambahkan method persistence di MATS untuk mengambil agregasi trade terakhir per symbol untuk session aktif.
2. Saat boot MATS setelah `orderService.Recover(ctx)`, rebuild `SummaryStore` dari trade persistence:
   - open, high, low, close/last, volume, value, frequency per symbol;
   - gunakan session aktif dari BEI/rules cache.
3. Publikasikan snapshot `last_price` dan `market_summary` hasil recovery ke WebSocket hub setelah recovery selesai.
4. Di Sekuritas backend, tambahkan fallback REST untuk initial market state dari BEI atau MATS saat WebSocket baru connect dan cache kosong.
5. Di frontend, saat `fetchMarketData()` menerima securities, isi `market.lastPrices` awal dari `last`/`reference_price`/`previous_close` yang sudah dinormalisasi agar UI tidak kosong atau mundur ke data salah.

## Confirmed Bug 3 - Seed MNDL memakai previous_close invalid tick size

Lokasi bukti:
- `BEI/src/db/seed.ts:33`
- `BEI/src/db/seed.ts:68-74`
- `MATS/internal/rules/cache.go:372-384`

Detail:
- Seed MNDL saat ini: `reference_price = 320`, `previous_close = 315`.
- Seed tick size:
  - 1-199: tick 1
  - 200-499: tick 2
  - 500-1999: tick 5
  - 2000-4999: tick 10
  - 5000 ke atas: tick 25
- Karena `315` berada di rentang 200-499, tick size yang berlaku adalah `2`.
- Validator MATS memakai `price % tickSize == 0`, sehingga `315 % 2 != 0`.

Rencana fix:
1. Ubah seed MNDL `previous_close` dari `315` menjadi harga valid terdekat.
2. Rekomendasi nilai: `316`, karena paling dekat dengan 315 dan valid untuk tick size 2.
3. Pastikan `reference_price = 320` tetap valid.
4. Tambahkan test ringan atau script validasi seed yang mengecek semua `reference_price`, `previous_close`, dan `ipo_price` seed terhadap tick size masing-masing.

## Confirmed Bug 4 - Frontend menghitung ARA/ARB tanpa pembulatan tick

Lokasi bukti:
- `SEKURITAS/frontend/src/pages/MarketDetail.tsx:215-240`
- `SEKURITAS/frontend/src/pages/MarketDetail.tsx:529-542`
- `SEKURITAS/frontend/src/pages/MarketDetail.tsx:2915-2923`
- `MATS/internal/rules/cache.go:206-210`
- `MATS/internal/rules/cache.go:388-406`

Detail:
- Frontend menghitung ARA dengan `Math.floor(refPrice * (1 + araPercent))`.
- Frontend menghitung ARB dengan `Math.ceil(refPrice * (1 - arbPercent))`.
- Hasil ini belum disesuaikan ke tick size.
- Backend MATS memvalidasi price band dan tick size secara terpisah, sehingga batas yang ditampilkan frontend bisa berupa angka yang tidak bisa dipakai sebagai harga order valid.
- Contoh: untuk harga di rentang tick 5, ARB hasil `ceil` bisa menjadi angka yang bukan kelipatan 5.

Rencana fix:
1. Buat helper bersama di frontend untuk:
   - menentukan tick size dari harga;
   - membulatkan ARA ke bawah ke tick valid;
   - membulatkan ARB ke atas ke tick valid.
2. Pakai helper tersebut untuk tampilan ARA/ARB, tombol stepper, validasi input, dan clamp price.
3. Jaga konsistensi dengan backend MATS, atau lebih baik expose rules snapshot dari backend agar frontend tidak hardcode fraksi harga.
4. Tambahkan minimal unit test untuk helper tick rounding.

## Potential Concern 1 - API create/patch security belum memvalidasi harga terhadap tick size

Lokasi bukti:
- `BEI/src/routes/issuers.ts:24-38`
- `BEI/src/routes/issuers.ts:117-127`
- `BEI/src/routes/issuers.ts:141-154`

Detail:
- Schema `securityBody` hanya memastikan `referencePrice` dan `previousClose` positif.
- Tidak ada validasi bahwa harga tersebut valid terhadap tick size profile board/market segment.
- Ini bukan penyebab langsung reset development, tetapi sumber data invalid yang sama bisa masuk lewat API admin.

Rencana fix:
1. Tambahkan validasi tick size saat create/patch security untuk `referencePrice`, `previousClose`, dan `ipoPrice`.
2. Validasi perlu mengambil rule profile berdasarkan `board` dan `marketMechanism`.
3. Jika belum ingin memblokir admin flow, mulai dari warning/audit log, lalu naikkan menjadi hard validation setelah UI admin siap.

## Urutan Eksekusi yang Disarankan

1. Perbaiki seed:
   - MNDL `previous_close` menjadi `316`.
   - `ON CONFLICT` tidak meng-overwrite `reference_price` dan `previous_close` kecuali reset eksplisit.
2. Tambahkan script/flag reset market eksplisit untuk development.
3. Tambahkan recovery market summary MATS dari persistence store saat boot.
4. Tambahkan fallback initial market state di Sekuritas backend/frontend.
5. Perbaiki helper ARA/ARB frontend agar rounded ke tick size valid.
6. Tambahkan validasi seed/API terkait tick size.
7. Jalankan test:
   - `npm test` atau test terkait BEI jika tersedia;
   - `go test ./...` di MATS;
   - build frontend Sekuritas;
   - skenario manual: trade MNDL, restart semua service development, pastikan last price/reference tidak reset kecuali reset eksplisit.

## Catatan Implementasi

- Perubahan seed harus hati-hati agar data statis tetap idempotent, tetapi data market yang dinamis tidak tertimpa.
- Untuk "tetap berlanjut walaupun server mati", sumber kebenaran harga harus persistent:
  - trade history di MATS/BEI;
  - market summary hasil agregasi;
  - listed securities reference/previous close hanya untuk baseline antar sesi, bukan cache intraday satu-satunya.
- Jika server mati di tengah sesi dan belum ada session close, recovery harus memakai trade yang sudah tersimpan, bukan menunggu trade baru.

## request_feedback

request_feedback = true

Plan ini bisa dieksekusi oleh Gemini 3 Flash untuk perubahan seed, helper frontend, dan fallback sederhana. Untuk recovery MATS dari persistence store dan sinkronisasi antar service, model yang lebih advanced lebih disarankan karena menyentuh Go persistence, WebSocket event, dan kontrak BEI/Sekuritas.
