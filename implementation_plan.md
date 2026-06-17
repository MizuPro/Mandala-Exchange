# Implementation Plan - Perbaikan Integrasi BEI-MATS

## Ringkasan Hasil Deep Bug Analyzer

Scope analisis: integrasi BEI-MATS, khususnya sync rules/instrument/session dari BEI ke MATS, order validation MATS, trade capture MATS ke BEI, test integrasi yang tersedia, dan checklist fitur yang ditandai selesai.

Hasil test otomatis:

- `MATS`: `go test ./...` lulus, 17 test passed.
- `BEI`: `npm run check` lulus.
- `BEI`: `npm test` lulus, 6 test passed.

Hasil smoke test real BEI-MATS:

- BEI health: OK.
- MATS health: OK, tetapi `rules.securities=0`, `rules.rule_profiles=0`, dan `session_status=""`.
- Manual sync MATS ke BEI gagal dengan error: `sync rules: unsupported numeric value <nil>`.
- Order real ke MATS ditolak dengan `reject_reason: rules unavailable`.

Kesimpulan: test otomatis lulus karena integration test MATS memakai fake BEI, bukan payload BEI nyata. Integrasi real BEI-MATS belum lancar.

## Bug 1 - MATS Tidak Bisa Decode Rule BEI dengan Nilai Numeric Null

Lokasi:

- `MATS/internal/bei/client.go:62-78`
- `MATS/internal/domain/types.go:138-191`
- `BEI/src/db/seed.ts:63-81`
- `BEI/src/routes/rules.ts:284`

Masalah:

BEI mengirim field nullable seperti `max_price: null` dan `max_reference_price: null` untuk rule open-ended. Di MATS, field tersebut didefinisikan sebagai `domain.NumericInt`, dan `NumericInt.UnmarshalJSON` memanggil `numericToFloat`. Fungsi itu hanya menerima `float64` atau `string`, sehingga JSON `null` menjadi error `unsupported numeric value <nil>`.

Dampak:

- `POST /v1/admin/sync/bei` gagal total.
- Cache rules MATS kosong.
- Order valid dari Sekuritas ke MATS ditolak dengan `rules unavailable`.
- Flow BEI-MATS tidak bisa masuk matching real.

Rencana perbaikan:

1. Tambahkan tipe nullable numeric di MATS, misalnya `NullableNumericInt` dan `NullableNumericFloat`, atau ubah `numericToFloat` agar `nil` diperlakukan sebagai zero hanya untuk field optional.
2. Ubah field optional di `MATS/internal/bei/client.go`:
   - `TickSizeRule.MaxPrice`
   - `PriceBandRule.MaxReferencePrice`
   - `AutoRejectionRule.MaxListedSharesPercent`
3. Pastikan logic rules tetap membedakan open-ended rule dengan nilai `0`, seperti kondisi existing `if maxPrice > 0`.
4. Tambahkan test decode payload BEI nyata yang mengandung `max_price:null` dan `max_reference_price:null`.
5. Jalankan ulang manual sync dan pastikan health MATS menunjukkan securities/rule_profiles/session terisi.

## Bug 2 - Seed BEI Tidak Idempotent untuk Rules dan Session

Lokasi:

- `BEI/src/db/seed.ts:41-49`
- `BEI/src/db/seed.ts:51-93`
- `BEI/src/db/seed.ts:96-118`
- `BEI/src/db/migrate.ts:134-186`

Masalah:

Seed memakai `ON CONFLICT DO NOTHING`, tetapi tabel `trading_rule_profiles`, `lot_size_rules`, `tick_size_rules`, `price_band_rules`, `auto_rejection_rules`, dan `session_templates` tidak punya unique constraint yang cocok. Akibatnya seed berulang membuat data duplikat.

Bukti smoke test:

- BEI mengembalikan `RULE_PROFILE_COUNT=16`, padahal seed logical hanya membuat 4 profile.
- Rule nested di profile pertama berlipat, misalnya `tick:10` dan `band:6`.

Dampak:

- Payload rules makin besar setiap seed diulang.
- Rule selection MATS bisa ambigu karena banyak profile default untuk board yang sama.
- Session active dipilih berdasarkan `created_at DESC`, sehingga seed berulang mengganti active session tanpa lifecycle yang jelas.

Rencana perbaikan:

1. Tambahkan unique index/constraint:
   - `trading_rule_profiles(board, market_segment)`
   - `lot_size_rules(profile_id, instrument_type, effective_date)`
   - `tick_size_rules(profile_id, min_price, max_price)`
   - `price_band_rules(profile_id, min_reference_price, max_reference_price)`
   - `auto_rejection_rules(profile_id)`
   - session template aktif perlu strategi jelas, misalnya partial unique untuk satu `is_active=true`.
2. Ubah seed menjadi upsert deterministik dengan `ON CONFLICT (...) DO UPDATE`.
3. Tambahkan migration cleanup untuk data duplikat di database lokal/dev.
4. Tambahkan test atau script verifikasi bahwa seed dua kali menghasilkan jumlah profile/rule/session yang sama.

## Bug 3 - Idempotency Order MATS Hanya In-Memory

Lokasi:

- `MATS/internal/orders/service.go:104-114`
- `MATS/internal/orders/service.go:472-483`
- `MATS/internal/persistence/store.go:131`
- `MATS/db/migrations/001_init.sql:61-66`

Masalah:

MATS hanya mengecek idempotency dari map memori `s.idempotency`. Padahal store sudah punya `FindOrderByIdempotency` dan migration sudah punya `mats_idempotency_records`, tetapi belum dipakai.

Dampak:

- Setelah restart service, retry dengan idempotency key sama bisa gagal karena unique constraint `mats_orders.idempotency_key`, atau menghasilkan response berbeda jika path operasi berbeda.
- Pada multi-instance, idempotency tidak konsisten.
- Task MATS `Implement idempotency untuk place/amend/cancel order` belum benar-benar production-safe.

Rencana perbaikan:

1. Sebelum membuat sequence/order baru, cek store persistent berdasarkan idempotency key.
2. Simpan response idempotent untuk place/amend/cancel di `mats_idempotency_records`, atau minimal reconstruct response dari order/trade persistent.
3. Bedakan operation idempotency (`place`, `amend`, `cancel`) supaya key sama tidak bisa dipakai lintas operasi.
4. Tambahkan test restart/recreate service dengan store yang sama.

## Bug 4 - Trade Capture BEI Tidak Memvalidasi Session ID dari MATS

Lokasi:

- `MATS/cmd/mats/main.go:67-68`
- `MATS/internal/matching/engine.go:236-249`
- `MATS/internal/matching/engine.go:262-269`
- `BEI/src/routes/trades.ts:9-22`
- `BEI/src/routes/trades.ts:25-44`

Masalah:

MATS mengisi `Trade.SessionID` dari `MATS_SESSION_ID`, default `local-session`, bukan dari active session BEI yang disinkronkan. BEI `POST /trades/capture` hanya mengecek `sessionId` non-empty, tetapi tidak memvalidasi session tersebut terhadap `session_templates`.

Dampak:

- Trade bisa tersimpan di BEI dengan session ID yang tidak sama dengan active session BEI.
- Report, settlement, custody, fee/tax, dan surveillance berbasis session bisa kosong atau tidak sesuai.
- Task BEI `Validasi symbol, session, broker, dan trade payload` belum lengkap untuk bagian session.

Rencana perbaikan:

1. MATS harus memakai session ID dari `rulesCache.ActiveSession` hasil sync BEI, bukan hanya env `MATS_SESSION_ID`.
2. BEI `trades/capture` harus validasi `sessionId` terhadap session aktif/valid.
3. Tambahkan test bahwa trade capture dengan session tidak dikenal ditolak.
4. Tambahkan integration test real/fake yang memastikan session ID trade sama dengan session dari `/integration/mats/sessions/active`.

## Gap Test dan Dokumentasi

Lokasi:

- `MATS/test/integration/flow_test.go:30-63`
- `MATS/test/integration/flow_test.go:192-207`
- `MATS/docs/runbook-debugging.md:29-30`
- `MATS/docs/api-contracts.md:14`
- `docs/SEKURITAS/API_CONTRACTS.md:11`
- `SEKURITAS/backend/src/services/order-service.ts:10`

Masalah:

Integration test MATS memakai fake BEI yang tidak mengandung nullable numeric field. Selain itu dokumentasi/test MATS masih memakai broker `MDLA`, sedangkan seed BEI dan backend Sekuritas memakai `MANDALA`.

Rencana perbaikan:

1. Tambahkan contract fixture dari payload BEI nyata untuk MATS test.
2. Tambahkan smoke/integration test yang menjalankan BEI app test instance dan MATS rules client terhadap payload BEI aktual.
3. Samakan broker code di docs/test fixture, atau dokumentasikan mapping `MDLA` vs `MANDALA` bila memang sengaja berbeda.

## Urutan Eksekusi Disarankan

1. Perbaiki nullable numeric decode di MATS.
2. Tambahkan test decode payload BEI nyata.
3. Perbaiki seed idempotency dan unique constraints BEI.
4. Bersihkan data duplikat dev/local.
5. Perbaiki session ID source untuk trade MATS dan validasi session di BEI.
6. Perbaiki persistent idempotency MATS.
7. Tambahkan integration test BEI-MATS yang tidak hanya memakai fake BEI.
8. Jalankan ulang:
   - `go test ./...` di `MATS`
   - `npm run check` dan `npm test` di `BEI`
   - smoke sync `POST /v1/admin/sync/bei`
   - smoke order buy/sell sampai trade capture BEI

## Fitur yang Belum Benar-Benar Terimplementasi

Berdasarkan checklist dokumen, tidak ada task BEI/MATS yang masih `[ ]`. Namun dari runtime dan audit kode, beberapa item yang ditandai selesai belum valid:

- Sync rules BEI-MATS belum berjalan terhadap payload BEI nyata.
- Idempotency MATS belum persistent.
- Validasi session trade capture BEI belum ada.
- Integration test BEI-MATS belum menguji BEI service nyata.
- Seed BEI belum aman diulang.

## Kelayakan Eksekusi Model

Plan ini bisa dieksekusi oleh Gemini 3 Flash untuk perbaikan mekanis kecil seperti nullable numeric dan dokumentasi. Namun untuk idempotency persistent, cleanup migration data duplikat, dan kontrak session BEI-MATS, disarankan memakai model yang lebih advanced karena menyentuh konsistensi data, migration, dan alur settlement/reporting lintas service.
