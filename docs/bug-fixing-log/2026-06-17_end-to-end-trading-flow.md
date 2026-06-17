# Bug Fixing Log - End-to-End Trading Flow

**Tanggal:** 2026-06-17
**Modul/Fitur:** End-to-End Trading Flow
**Mode Analisis:** deep
**Dikerjakan oleh:** Agent + User

---

## Masalah yang Ditemukan

### 1. MATS tidak bisa compile
- **File:** `MATS/internal/persistence/store.go` (baris 158), `MATS/internal/persistence/memory.go` (baris 79)
- **Deskripsi:** `PostgresStore.SaveTrade` memiliki argumen SQL terduplikasi dan literal rusak, sementara `MemoryStore` belum mengimplementasikan `FindTradesByOrderID` yang diwajibkan interface `Store`.
- **Severity:** Critical

### 2. Fill dua sisi trade bisa hilang di SEKURITAS
- **File:** `SEKURITAS/backend/src/db/schema.ts` (baris 113), `SEKURITAS/backend/src/services/order-service.ts` (baris 308), `MATS/internal/events/dispatcher.go` (baris 90)
- **Deskripsi:** MATS mengirim fill untuk sisi buy dan sell dengan `trade_id` yang sama, tetapi unique index SEKURITAS hanya memakai `trade_id`, sehingga salah satu sisi bisa dianggap duplicate dan tidak memutasi portfolio.
- **Severity:** Critical

### 3. Sell reservation tidak dilepas saat order terminal
- **File:** `SEKURITAS/backend/src/services/order-service.ts` (baris 295), `SEKURITAS/backend/src/services/order-service.ts` (baris 409)
- **Deskripsi:** Release reserved shares untuk sell order bergantung pada `remaining_quantity` dari payload MATS. Untuk status `rejected`, `cancelled`, atau `expired`, payload dapat berisi `0` walau saham masih tersimpan di reserved lokal.
- **Severity:** Critical

### 4. Settlement BUY diproses sebagai SELL di SEKURITAS
- **File:** `SEKURITAS/backend/src/services/settlement-service.ts` (baris 48), `SEKURITAS/backend/src/services/settlement-service.ts` (baris 90)
- **Deskripsi:** Order side disimpan lowercase (`buy`/`sell`), tetapi settlement membandingkan dengan uppercase (`"BUY"`). Akibatnya settlement buy masuk cabang sell dan perhitungan cash/position salah.
- **Severity:** Critical

### 5. Auto-settlement BEI tidak bisa dipicu oleh MATS
- **File:** `BEI/src/lib/auth.ts` (baris 12), `BEI/src/routes/rules.ts` (baris 202), `BEI/.env.example` (baris 5)
- **Deskripsi:** Endpoint sync status sesi dari MATS tidak punya permission eksplisit, sehingga default ke `admin:*`. Auto-settlement juga mencoba memakai token MATS untuk endpoint settlement admin yang membutuhkan `settlement:write`.
- **Severity:** Critical

### 6. Lookup settlement fill tidak scoped ke order
- **File:** `SEKURITAS/backend/src/services/settlement-service.ts` (baris 35), `SEKURITAS/backend/src/db/schema.ts` (baris 121)
- **Deskripsi:** Settlement mencari existing fill hanya berdasarkan `trade_id`. Dalam satu trade, buy dan sell memiliki `trade_id` sama, sehingga settlement sisi kedua bisa membaca fill milik order lain.
- **Severity:** High

### 7. Manual sync BEI di MATS tidak mengupdate session ID engine
- **File:** `MATS/internal/api/handlers.go` (baris 42), `MATS/internal/rules/subscriber.go` (baris 70)
- **Deskripsi:** Redis subscriber sudah mengupdate session ID engine setelah refresh BEI, tetapi endpoint manual `POST /v1/admin/sync/bei` hanya refresh rules tanpa menyamakan session ID engine.
- **Severity:** High

### 8. UX quantity frontend belum mengikuti lot size
- **File:** `SEKURITAS/frontend/src/components/OrderEntry.tsx` (baris 136), `MATS/internal/rules/cache.go` (baris 178)
- **Deskripsi:** Frontend menerima quantity shares bebas dengan placeholder `1`, sedangkan MATS menolak order yang tidak sesuai lot size.
- **Severity:** Low

---

## Solusi yang Dikerjakan

### 1. MATS tidak bisa compile
- **Perubahan yang Dilakukan:** Menghapus argumen SQL duplikat di `PostgresStore.SaveTrade`, menambahkan `MemoryStore.FindTradesByOrderID`, lalu menjalankan `gofmt`.
- **File yang Dimodifikasi:** `MATS/internal/persistence/store.go`, `MATS/internal/persistence/memory.go`
- **Catatan:** Setelah fix, `go test ./...` di MATS lulus.

### 2. Fill dua sisi trade bisa hilang di SEKURITAS
- **Perubahan yang Dilakukan:** Mengubah unique index `trade_fills` dari `trade_id` menjadi composite `(order_id, trade_id)` dan menambahkan migration untuk drop index lama serta create index baru.
- **File yang Dimodifikasi:** `SEKURITAS/backend/src/db/schema.ts`, `SEKURITAS/backend/src/db/migrations/0003_trading_flow_consistency.sql`
- **Catatan:** Migration `0003` perlu dijalankan di database target sebelum flow live dipakai.

### 3. Sell reservation tidak dilepas saat order terminal
- **Perubahan yang Dilakukan:** Release reserved shares sekarang memakai state lokal order sebelum update, dikurangi fill yang diproses, dan menjaga reserved tidak negatif dengan `GREATEST(0, ...)`.
- **File yang Dimodifikasi:** `SEKURITAS/backend/src/services/order-service.ts`
- **Catatan:** Ini mencegah saham pemain terkunci permanen ketika payload terminal MATS membawa `remaining_quantity = 0`.

### 4. Settlement BUY diproses sebagai SELL di SEKURITAS
- **Perubahan yang Dilakukan:** Menambahkan normalisasi side di awal `processSettlement`, mapping fee side ke uppercase hanya untuk kalkulasi fee, dan memakai side normalisasi untuk cabang buy/sell.
- **File yang Dimodifikasi:** `SEKURITAS/backend/src/services/settlement-service.ts`
- **Catatan:** Fix ini menjaga buy settlement memindahkan pending shares ke available, bukan masuk logic realized P/L sell.

### 5. Auto-settlement BEI tidak bisa dipicu oleh MATS
- **Perubahan yang Dilakukan:** Menambahkan scope `session:write`, memberi permission eksplisit untuk `POST /v1/integration/mats/sessions/active/status`, memperbarui default/env example token MATS, dan membuat auto-settlement memakai token internal yang punya `admin:*` atau `settlement:write`.
- **File yang Dimodifikasi:** `BEI/src/config.ts`, `BEI/src/types/auth.ts`, `BEI/src/lib/auth.ts`, `BEI/src/routes/rules.ts`, `BEI/.env.example`, `BEI/test/contracts.test.ts`
- **Catatan:** `BEI/.env` lokal juga disesuaikan agar test lokal memakai scope baru, tetapi file itu tidak tracked oleh git.

### 6. Lookup settlement fill tidak scoped ke order
- **Perubahan yang Dilakukan:** Lookup `existingFill` di settlement sekarang menggunakan kombinasi `order_id` dan `trade_id`, selaras dengan unique index baru.
- **File yang Dimodifikasi:** `SEKURITAS/backend/src/services/settlement-service.ts`, `SEKURITAS/backend/src/db/schema.ts`, `SEKURITAS/backend/src/db/migrations/0003_trading_flow_consistency.sql`
- **Catatan:** Ini mencegah settlement sisi buy membaca fill milik sisi sell, atau sebaliknya.

### 7. Manual sync BEI di MATS tidak mengupdate session ID engine
- **Perubahan yang Dilakukan:** Setelah `rules.Refresh` sukses di handler `SyncBEI`, engine sekarang dipanggil dengan `UpdateSessionID(rules.ActiveSessionID())`.
- **File yang Dimodifikasi:** `MATS/internal/api/handlers.go`
- **Catatan:** Behavior manual sync kini konsisten dengan Redis subscriber.

### 8. UX quantity frontend belum mengikuti lot size
- **Perubahan yang Dilakukan:** Belum dikerjakan pada sesi ini karena perubahan utama difokuskan pada blocker compile, ledger consistency, settlement, dan auth/session flow.
- **File yang Dimodifikasi:** -
- **Catatan:** Masih menjadi follow-up rendah prioritas untuk mengurangi rejected order dari UI.

---

## Pelajaran yang Dipetik

1. Kontrak idempotency untuk trade/fill harus menyertakan dimensi order atau side; `trade_id` tunggal tidak cukup ketika satu trade menghasilkan dua fill.
2. Jangan memakai payload terminal eksternal sebagai satu-satunya sumber release reservation; state lokal sebelum update tetap diperlukan untuk menghitung sisa reserved yang benar.
3. Normalisasi enum lintas service harus dilakukan di boundary service, terutama saat satu ekosistem memakai lowercase dan ekosistem lain memakai uppercase.
4. Permission internal sebaiknya sempit dan eksplisit. MATS butuh `session:write`, bukan akses `admin:*` atau `settlement:write`.
5. Semua jalur refresh state harus melakukan update yang sama. Manual sync, startup sync, dan subscriber event tidak boleh punya efek samping berbeda terhadap session ID engine.
6. Migration database wajib menyertai perubahan schema Drizzle agar runtime dan model TypeScript tetap konsisten.
7. Test compile/build lintas ekosistem perlu dijalankan setelah fix cross-service, karena bug end-to-end sering muncul dari type/scope/contract yang berbeda antar service.
