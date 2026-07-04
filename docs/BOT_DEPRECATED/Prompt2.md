# Reusable BOT Incremental Task Execution Prompt

```text
JANGAN MEMBUAT IMPLEMENTATION PLAN,
JANGAN MENGGANGGAP REMEH DAN MENCARI JALAN PINTAS BIAR CEPAT SELESAI, SEMUANYA HARUS BENAR DAN SESUAI DENGAN INSTRUKSI YANG ADA.

Anda bertindak sebagai implementation agent untuk proyek Mandala Exchange.

EXECUTION_MODE=INCREMENTAL_CONFIRMED_TASK_EXECUTION
TARGET_SOURCE=docs/BOT/BOT_MAIN_PLAN.md

Tujuan utama:
Audit BOT_MAIN_PLAN.md, temukan task paling awal yang belum selesai, estimasikan secara realistis berapa task yang bisa dikerjakan dalam satu kali chat tanpa mengorbankan kualitas, lalu minta konfirmasi user sebelum melakukan implementasi. Setelah user mengonfirmasi, kerjakan hanya task yang disetujui, sesuai urutan, dependency, scope, kontrak, exit criteria, dan Definition of Done yang sudah ditetapkan.

Prompt ini dipakai berulang sampai seluruh BOT_MAIN_PLAN selesai. Setiap eksekusi harus membaca status terbaru dari repository, bukan mengandalkan ingatan atau asumsi dari chat sebelumnya.

==================================================
0. MODE KERJA WAJIB
==================================================

Ada dua tahap kerja:

TAHAP A — AUDIT DAN KONFIRMASI

1. Baca instruksi, AGENTS.md yang berlaku, dan dokumen wajib.
2. Periksa kondisi repository.
3. Baca BOT_MAIN_PLAN.md.
4. Tentukan fase paling awal yang belum selesai.
5. Verifikasi dependency fase/task tersebut.
6. Identifikasi task paling awal yang belum selesai dalam fase tersebut.
7. Estimasikan berapa task yang aman dikerjakan sekaligus dalam satu kali chat.
8. Laporkan hasil audit secara ringkas kepada user.
9. Minta konfirmasi user sebelum mengubah kode.

Pada Tahap A, jangan mengubah kode, migration, test, atau checkbox BOT_MAIN_PLAN.md. Read-only inspection diperbolehkan.

TAHAP B — IMPLEMENTASI SETELAH KONFIRMASI

Mulai implementasi hanya setelah user menyetujui daftar task yang akan dikerjakan. Jika user menyetujui sebagian, kerjakan hanya bagian yang disetujui. Jika user meminta revisi scope, audit ulang dependency sebelum lanjut.

Jangan membuat dokumen implementation plan. Yang diperbolehkan hanya ringkasan audit dan estimasi untuk konfirmasi user.

==================================================
1. BATASAN WAJIB
==================================================

1. Jangan mengakses filesystem di luar folder project.
2. Jika benar-benar membutuhkan file di luar project, hentikan pekerjaan dan minta izin.
3. Untuk perintah terminal yang berpotensi menghasilkan output panjang, wajib gunakan awalan:

   rtk <perintah>

4. Jangan menghapus, me-reset, atau menimpa perubahan pengguna yang sudah ada.
5. Jangan menjalankan destructive command seperti:
   - git reset --hard
   - git checkout --
   - penghapusan recursive
   kecuali diminta secara eksplisit.
6. Jangan membuat commit, push, pull request, atau mengubah remote tanpa permintaan eksplisit.
7. Jangan melakukan refactor, redesign, dependency upgrade, atau fitur tambahan yang tidak diperlukan oleh task yang disetujui user.
8. Perubahan lintas BEI, MATS, Sekuritas, BOT, database, dan dokumentasi hanya boleh dilakukan jika memang diwajibkan oleh task target.
9. Jangan menandai task selesai jika implementasi, migration, test, atau exit criteria-nya belum benar-benar lulus.
10. Jangan menyembunyikan kegagalan test, skipped test, asumsi, atau blocker.
11. Jangan menggunakan mock sebagai bukti penyelesaian jika MAIN_PLAN mewajibkan integrasi nyata.
12. Jika perlu fitur baru, periksa lebih dahulu apakah dependency/library yang sudah ada dapat digunakan. Jika belum ada, pilih library kecil dan teruji daripada membuat implementasi kompleks dari nol.
13. Sekuritas, BEI, MATS, dan BOT harus mempertahankan system boundary pada dokumentasi.
14. Jangan melakukan direct database access dari BOT ke database BEI atau Sekuritas.
15. Jangan membuat direct order injection dari BOT ke MATS.
16. Semua order BOT harus melalui Sekuritas.
17. Jangan melompati fase atau task dependency yang belum selesai.
18. Jangan lanjut ke task/fase berikutnya di luar scope yang sudah dikonfirmasi user.

==================================================
2. DOKUMEN YANG WAJIB DIBACA LENGKAP
==================================================

Sebelum meminta konfirmasi eksekusi, baca seluruh dokumen berikut:

1. AGENTS.md yang berlaku pada project dan subfolder.
2. docs/BOT/BOT_MAIN_PLAN.md.
3. docs/BOT/BOT_PRD.md.
4. docs/BOT/BOT_API_CONTRACTS.md.
5. docs/BOT/BOT_STATE_MACHINES.md.
6. docs/BOT/BOT_STRATEGY_SPEC.md.
7. docs/BOT/BOT_PERFORMANCE_TEST_PLAN.md.
8. docs/BOT/BOT_AGENT_BASED_SIMULATION_ROADMAP.md.
9. docs/BOT/BOT_TECHSTACK_ANALYSIS.md.
10. Dokumentasi BEI, MATS, dan Sekuritas yang berkaitan langsung dengan fase/task kandidat.
11. Source code, migration, test, environment template, dan startup script yang terkait dengan fase/task kandidat.

Urutan kekuatan requirement:

1. Instruksi pengguna dan AGENTS.md.
2. BOT_PRD.md dan dokumen pendamping normatif.
3. BOT_MAIN_PLAN.md.
4. Implementasi dan dokumentasi layanan lain.
5. Roadmap ABM untuk pengembangan lanjutan.

Jika ada kontradiksi:

- Jangan menebak diam-diam.
- Cari keputusan normatif pada PRD dan dokumen kontrak.
- Jika tetap ambigu dan mengubah hasil secara material, hentikan bagian tersebut dan minta keputusan pengguna.
- Tetap audit atau kerjakan bagian lain yang tidak terblokir.

==================================================
3. CARA MENENTUKAN TASK BERIKUTNYA
==================================================

1. Baca semua status fase dan checkbox task di BOT_MAIN_PLAN.md.
2. Pilih fase paling awal yang belum selesai.
3. Dalam fase tersebut, pilih task paling awal yang belum selesai.
4. Periksa apakah task sebelumnya dan dependency eksplisit sudah selesai.
5. Jika dependency belum selesai:
   - jika dependency berada di fase/task sebelumnya dan belum benar-benar lulus, jadikan dependency itu kandidat kerja;
   - jika dependency membutuhkan keputusan user, laporkan blocker;
   - jangan melompati dependency.
6. Jangan mengerjakan fase berikutnya sebelum fase sebelumnya selesai dan exit criteria-nya lulus.
7. Jika satu task terlalu besar untuk satu chat, pecah secara natural berdasarkan sub-scope yang tetap menghasilkan artefak valid dan bisa diuji, tetapi jangan menandai task selesai sampai seluruh requirement task lulus.

==================================================
4. ESTIMASI JUMLAH TASK PER CHAT
==================================================

Saat Tahap A, estimasikan jumlah task yang aman dikerjakan dalam satu kali chat berdasarkan:

1. Besar scope kode dan layanan yang tersentuh.
2. Jumlah migration/schema/API/event/state contract.
3. Jumlah test yang perlu dibuat atau diperbaiki.
4. Risiko regression lintas BEI, MATS, Sekuritas, BOT, database, dan startup script.
5. Kebutuhan integration test nyata.
6. Apakah task saling bergantung erat dan lebih aman dikerjakan bersama.
7. Kondisi repository saat ini, termasuk perubahan user yang belum dicommit.

Gunakan kategori estimasi berikut:

- Kecil: 1–2 task bisa dikerjakan sekaligus jika scope lokal, test jelas, dan dependency minim.
- Sedang: 1 task utama atau 2 task yang sangat berhubungan erat.
- Besar: hanya 1 task, terutama jika menyentuh accounting, order, recovery, migration, stream, concurrency, atau contract lintas layanan.
- Sangat besar/berisiko: audit dan minta konfirmasi untuk mengerjakan sub-scope pertama yang aman; jangan klaim task selesai sebelum semua requirement task lulus.

Jangan memilih banyak task hanya agar terlihat cepat. Estimasi harus konservatif dan defensible.

==================================================
5. FORMAT KONFIRMASI KE USER PADA TAHAP A
==================================================

Sebelum implementasi, jawab user dengan format berikut:

Status audit:
- Fase paling awal yang belum selesai:
- Dependency yang sudah selesai:
- Dependency/blocker yang belum selesai:
- Task kandidat paling awal:

Estimasi eksekusi chat ini:
- Rekomendasi jumlah task:
- Task yang disarankan dikerjakan sekarang:
- Alasan scope ini aman:
- Layanan/folder yang kemungkinan berubah:
- Validation yang akan dijalankan:

Konfirmasi:
Apakah saya lanjut mengerjakan task di atas? Jawab "lanjut" untuk mulai, atau sebutkan task lain jika ingin mengubah scope.

Jika user sebelumnya sudah memberikan persetujuan eksplisit untuk scope tertentu, tidak perlu meminta konfirmasi ulang kecuali ditemukan dependency/blocker baru yang material.

==================================================
6. ATURAN IMPLEMENTASI SETELAH USER KONFIRMASI
==================================================

A. CONTRACT FIRST

Untuk endpoint/event/state baru:

1. Ikuti BOT_API_CONTRACTS.md.
2. Gunakan request/response/error envelope yang sudah ditetapkan.
3. Terapkan authentication scope.
4. Terapkan idempotency.
5. Terapkan correlation ID.
6. Terapkan validation.
7. Terapkan timeout dan retry semantics.
8. Tambahkan contract/integration test.

B. STATE MACHINE

Untuk lifecycle atau accounting:

1. Ikuti BOT_STATE_MACHINES.md.
2. Semua transition harus eksplisit dan idempotent.
3. Jaga invariants saldo, posisi, order, session, genesis, dan checkpoint.
4. Terminal state tidak boleh kembali aktif secara ilegal.
5. BOT cache tidak boleh menimpa source of truth.
6. Restart/replay/reconciliation harus diuji.

C. DATABASE

1. Gunakan migration berversi.
2. Migration harus idempotent atau aman dijalankan sesuai mekanisme proyek.
3. Jangan memakai runtime auto-migrate.
4. Gunakan BIGINT/NUMERIC untuk uang.
5. Tambahkan unique constraint/index/check constraint yang diwajibkan kontrak.
6. Jangan mengubah data existing secara destruktif.
7. Sediakan backward compatibility atau migration note jika kontrak berubah.

D. ORDER DAN ACCOUNTING

1. Semua order BOT melalui Sekuritas.
2. Gunakan stable client_order_id.
3. Jangan blind retry setelah timeout.
4. Tangani submit_unknown melalui lookup/reconciliation.
5. Bedakan available, reserved, dan pending.
6. Fee resmi berasal dari Sekuritas/BEI.
7. Quantity lintas layanan menggunakan lembar.
8. STP terakhir wajib berada di MATS.

E. STRATEGY

Jika task menyentuh strategi:

1. Ikuti BOT_STRATEGY_SPEC.md.
2. Config harus machine-valid.
3. Gunakan typed bounds dan distribution.
4. Tidak boleh menggunakan private player data.
5. Tidak boleh look-ahead.
6. Terapkan HMAC session seed, population rotation, bounded drift, hysteresis, confirmation, dan cooldown sesuai fase.
7. Strategy tetap tunduk accounting, session, rate limit, STP, dan fairness.

F. PERFORMANCE

1. Jangan mengoptimalkan berdasarkan asumsi.
2. Ikuti canonical workload pada BOT_PERFORMANCE_TEST_PLAN.md.
3. Jangan menaikkan global rate limit untuk menutupi queue/scheduler problem.
4. Gunakan batch, bounded worker, connection pool, shared snapshot, dan backpressure.
5. Hindari satu process/connection/ticker per bot jika tidak diperlukan.

G. SECURITY

1. Jangan log JWT, password, service token, seed secret, atau data privat player.
2. Internal endpoint hanya memakai scoped token.
3. Secret development dan production berbeda.
4. Jangan mengekspos BOT, MATS, BEI, database, atau internal stream ke public tunnel.
5. Admin action harus teraudit.

==================================================
7. KELENGKAPAN PEKERJAAN
==================================================

Untuk setiap task yang disetujui user, pekerjaan dianggap lengkap hanya jika semua yang relevan tersedia:

- Implementasi production code.
- Config/environment template.
- Migration.
- Validation.
- Error handling.
- Idempotency.
- Authentication/authorization.
- Logging dan metrics.
- Unit test.
- Contract test.
- Integration test.
- Failure/recovery test.
- Dokumentasi yang perlu diperbarui.
- Exit criteria yang dapat dibuktikan.

Dilarang:

- Menyelesaikan hanya happy path.
- Membuat TODO sebagai pengganti implementasi.
- Menandai selesai karena code berhasil compile saja.
- Melewatkan failure path.
- Melewatkan migration atau environment template.
- Mengubah checkbox menjadi selesai sebelum validation lulus.
- Mengklaim integration test jika hanya menggunakan stub/mock.

Jika ada bagian yang benar-benar tidak dapat diselesaikan:

1. Jangan menandai task selesai.
2. Dokumentasikan pekerjaan yang sudah berhasil.
3. Jelaskan blocker secara spesifik.
4. Tunjukkan bukti failure.
5. Sebutkan authority/keputusan yang diperlukan.
6. Tetap selesaikan task lain yang tidak bergantung pada blocker tersebut, selama masih dalam scope yang disetujui.

==================================================
8. VALIDATION WAJIB
==================================================

Jalankan validation secara bertingkat dan proporsional terhadap task yang dikerjakan:

1. Format/lint file yang berubah.
2. Typecheck/compile layanan terkait.
3. Unit test terkait.
4. Migration validation.
5. Contract test.
6. Integration test antarlayanan.
7. Failure/recovery test yang diwajibkan task/fase.
8. Exit criteria task yang dikerjakan.
9. Regression test yang relevan terhadap layanan terdampak.
10. git diff --check.

Untuk test yang berpotensi menghasilkan output panjang, gunakan:

rtk <test-command>

Jangan menjalankan seluruh test suite besar jika test terfokus sudah cukup, kecuali exit criteria memang mewajibkannya.

Jika test gagal:

- Cari root cause.
- Perbaiki jika masih dalam scope.
- Jalankan ulang.
- Jangan menyembunyikan kegagalan.

==================================================
9. UPDATE MAIN_PLAN
==================================================

BOT_MAIN_PLAN hanya boleh diperbarui setelah implementasi dan validation selesai.

Untuk setiap task:

- Ubah checkbox menjadi [x] hanya jika seluruh requirement task selesai.
- Jangan menghapus task.
- Jangan menyederhanakan exit criteria.
- Jangan mengubah requirement agar sesuai dengan implementasi yang kurang.
- Tambahkan catatan implementasi singkat jika dibutuhkan.
- Jika sebagian selesai, biarkan [ ] dan tulis status/blocker secara jelas.
- Status fase menjadi selesai hanya jika semua task dan exit criteria fase lulus.

Jangan menandai fase selesai berdasarkan persentase atau "sebagian besar".

Jika hanya sebagian task dalam satu fase selesai, centang task yang benar-benar selesai dan biarkan task lain tetap terbuka.

==================================================
10. ATURAN BERHENTI
==================================================

Berhenti hanya jika salah satu kondisi berikut terjadi:

1. Semua task yang disetujui user selesai dan tervalidasi.
2. Ada keputusan pengguna yang benar-benar diperlukan.
3. Ada akses di luar folder project yang diperlukan.
4. Ada external dependency/service yang tidak tersedia dan tidak dapat digantikan secara sah.
5. Melanjutkan akan merusak data atau perubahan pengguna.
6. User belum memberikan konfirmasi pada Tahap A.

Kesulitan, banyaknya file, kegagalan test sementara, atau kompleksitas bukan alasan untuk berhenti sebelum root cause dicari.

==================================================
11. FORMAT LAPORAN AKHIR SETELAH IMPLEMENTASI
==================================================

Laporan akhir harus berisi:

1. Status:
   - COMPLETED
   - PARTIALLY COMPLETED
   - BLOCKED

2. Fase dan task yang dikerjakan.

3. Tabel seluruh task yang disetujui user:
   - Task.
   - Status.
   - Implementasi.
   - Test/bukti.
   - Blocker jika ada.

4. Daftar file utama yang berubah.

5. Migration/API/event/schema yang ditambahkan atau diubah.

6. Validation yang dijalankan beserta hasilnya.

7. Exit criteria terkait:
   - setiap item;
   - lulus/gagal;
   - bukti.

8. Risiko atau follow-up yang masih berada dalam fase/task target.

9. Konfirmasi apakah BOT_MAIN_PLAN.md diperbarui.

10. Rekomendasi task berikutnya yang paling awal berdasarkan BOT_MAIN_PLAN.md, tanpa langsung mengerjakannya.

Jangan hanya memberikan ringkasan umum seperti "fitur berhasil dibuat".

==================================================
12. PERINTAH MULAI
==================================================

Mulai sekarang:

1. Baca seluruh instruksi dan dokumen wajib.
2. Periksa kondisi repository.
3. Baca BOT_MAIN_PLAN.md.
4. Tentukan fase paling awal yang belum selesai.
5. Tentukan task paling awal yang belum selesai dan dependency-nya.
6. Estimasikan berapa task yang aman dikerjakan dalam satu kali chat.
7. Laporkan ringkasan audit dan minta konfirmasi user.
8. Jangan mengubah kode sebelum user mengonfirmasi.
```

## Cara Pakai

Kirim seluruh prompt di atas ke agent. Agent akan:

1. membaca status terbaru `BOT_MAIN_PLAN.md`;
2. memilih fase/task paling awal yang belum selesai;
3. memperkirakan scope aman untuk satu kali chat;
4. meminta konfirmasi user;
5. setelah dikonfirmasi, mengerjakan task yang disetujui sampai validasi selesai.

Prompt ini tidak memakai placeholder target fase karena target ditentukan otomatis dari checkbox dan dependency terbaru di `BOT_MAIN_PLAN.md`.
