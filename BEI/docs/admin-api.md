# Dokumentasi API Admin - BEI Service

Dokumentasi ini menjelaskan seluruh endpoint administratif (operator bursa) pada BEI Service. Semua API dilindungi dengan token autentikasi khusus.

---

## 1. Keamanan & Autentikasi

Semua request administratif ke BEI Service wajib menyertakan header `x-service-token`.
*   **Header:** `x-service-token: <ADMIN_SERVICE_TOKEN>`
*   **Scope yang Dibutuhkan:** `admin:*` (atau scope khusus seperti `settlement:write`, `corporate-action:write`, dan `surveillance:write` untuk fungsionalitas tertentu).
*   **Format Prefix Path:** Semua API menggunakan prefix `/v1` di awal jalurnya.

---

## 2. Pengelolaan Master Data Emiten & Saham (`/v1/issuers` & `/v1/securities`)

### 2.1. Membuat Emiten Baru
Digunakan untuk mendaftarkan emiten (perusahaan tercatat) baru di bursa.

*   **Method:** `POST`
*   **Path:** `/v1/issuers`
*   **Request Body (JSON):**
    ```json
    {
      "code": "MNDL",
      "name": "PT Mandala Digital Indonesia Tbk",
      "sector": "Technology",
      "summary": "Perusahaan teknologi terkemuka penyedia infrastruktur bursa simulasi.",
      "businessDescription": "Fokus pada pengembangan ekosistem blockchain dan microservices.",
      "isActive": true,
      "metadata": {}
    }
    ```
*   **Response (200 OK):**
    ```json
    {
      "id": "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
      "code": "MNDL",
      "name": "PT Mandala Digital Indonesia Tbk",
      "sector": "Technology",
      "summary": "Perusahaan teknologi terkemuka penyedia infrastruktur bursa simulasi.",
      "businessDescription": "Fokus pada pengembangan ekosistem blockchain dan microservices.",
      "isActive": true,
      "metadata": {},
      "createdAt": "2026-06-17T12:00:00.000Z",
      "updatedAt": "2026-06-17T12:00:00.000Z"
    }
    ```

### 2.2. Mengubah Profil Emiten
Digunakan untuk memperbarui informasi emiten secara parsial.

*   **Method:** `PATCH`
*   **Path:** `/v1/issuers/:id`
*   **Params:** `id` (UUID Emiten)
*   **Request Body (JSON):** (Semua field bersifat opsional)
    ```json
    {
      "name": "PT Mandala Digital Tbk",
      "summary": "Profil perusahaan terbaru yang diperbarui oleh admin."
    }
    ```
*   **Response (200 OK):** JSON objek emiten yang telah diperbarui.

### 2.3. Mendapatkan Detail Emiten
Melihat informasi spesifik suatu emiten berdasarkan ID-nya.

*   **Method:** `GET`
*   **Path:** `/v1/issuers/:id`
*   **Params:** `id` (UUID Emiten)
*   **Response (200 OK):** JSON objek emiten.

### 2.4. Mendaftarkan Saham Baru (Listed Security)
Mendaftarkan instrumen saham dari emiten ke papan perdagangan bursa.

*   **Method:** `POST`
*   **Path:** `/v1/securities`
*   **Request Body (JSON):**
    ```json
    {
      "issuerId": "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
      "symbol": "MNDL",
      "name": "Mandala Digital",
      "board": "main", // Pilihan: "main" | "development" | "acceleration" | "new_economy" | "watchlist"
      "sector": "Technology",
      "sharesOutstanding": 1000000000,
      "ipoPrice": 100, // Opsional
      "referencePrice": 100,
      "previousClose": 100, // Opsional
      "status": "listed", // Pilihan: "listed" | "suspended" | "delisted"
      "marketMechanism": "regular", // Pilihan: "regular" | "call_auction"
      "listedAt": "2026-06-17", // Format: YYYY-MM-DD (Opsional)
      "suspendedReason": null, // Opsional
      "metadata": {}
    }
    ```
*   **Response (200 OK):**
    ```json
    {
      "id": "e4b3c2d1-5a6b-7c8d-9e0f-1a2b3c4d5e6f",
      "issuerId": "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
      "symbol": "MNDL",
      "name": "Mandala Digital",
      "board": "main",
      "sector": "Technology",
      "sharesOutstanding": "1000000000",
      "ipoPrice": "100.00",
      "referencePrice": "100.00",
      "previousClose": "100.00",
      "status": "listed",
      "marketMechanism": "regular",
      "listedAt": "2026-06-17",
      "suspendedReason": null,
      "metadata": {},
      "createdAt": "2026-06-17T12:00:00.000Z",
      "updatedAt": "2026-06-17T12:00:00.000Z"
    }
    ```

### 2.5. Mengubah Parameter Saham
Memperbarui data dan aturan saham yang terdaftar secara parsial.

*   **Method:** `PATCH`
*   **Path:** `/v1/securities/:symbol`
*   **Params:** `symbol` (Kode saham, e.g. `MNDL`)
*   **Request Body (JSON):** (Semua field bersifat opsional)
    ```json
    {
      "board": "watchlist",
      "referencePrice": 120,
      "status": "listed"
    }
    ```
*   **Response (200 OK):** JSON objek instrumen saham setelah diperbarui.

### 2.6. Memberikan Notasi Khusus Saham (Special Notation)
Menambahkan kriteria pengawasan khusus (seperti suspensi atau papan pemantauan khusus) pada saham.

*   **Method:** `POST`
*   **Path:** `/v1/securities/:symbol/notations`
*   **Params:** `symbol` (Kode saham, e.g. `MNDL`)
*   **Request Body (JSON):**
    ```json
    {
      "type": "special_monitoring", // Pilihan: "suspend" | "special_monitoring" | "delisting_risk" | dll.
      "note": "Perusahaan sedang dalam pengawasan karena volatilitas tinggi.",
      "isActive": true,
      "effectiveFrom": "2026-06-17T12:00:00Z", // Opsional
      "effectiveTo": null // Opsional
    }
    ```
*   **Response (200 OK):** JSON objek notasi khusus yang dibuat.

### 2.7. Melakukan Suspensi Perdagangan Saham (Manual Suspend)
Menghentikan perdagangan untuk saham tertentu secara manual.

*   **Method:** `POST`
*   **Path:** `/v1/securities/:symbol/suspend`
*   **Params:** `symbol` (Kode saham, e.g. `MNDL`)
*   **Request Body (JSON):**
    ```json
    {
      "reason": "Unusual Market Activity (UMA)"
    }
    ```
*   **Response (200 OK):** Objek saham dengan status terbaru `suspended`.

### 2.8. Mengaktifkan Kembali Saham yang Disuspensi (Manual Resume)
Membuka kembali status suspensi agar saham dapat ditransaksikan kembali.

*   **Method:** `POST`
*   **Path:** `/v1/securities/:symbol/resume`
*   **Params:** `symbol` (Kode saham, e.g. `MNDL`)
*   **Response (200 OK):** Objek saham dengan status terbaru `listed`.

### 2.9. Membuat Pengumuman Emiten (Issuer Announcement)
Mempublikasikan keterbukaan informasi emiten.

*   **Method:** `POST`
*   **Path:** `/v1/issuers/:issuerId/announcements`
*   **Params:** `issuerId` (UUID Emiten)
*   **Request Body (JSON):**
    ```json
    {
      "securityId": "e4b3c2d1-5a6b-7c8d-9e0f-1a2b3c4d5e6f", // Opsional
      "type": "corporate_action", // Pilihan: "financial_report" | "audit_report" | "corporate_action" | "other"
      "title": "Pengumuman Rencana Stock Split",
      "body": "Perseroan merencanakan pemecahan nilai nominal saham (stock split) dengan rasio 1:2.",
      "publishedAt": "2026-06-17T12:00:00Z", // Opsional
      "metadata": {}
    }
    ```
*   **Response (200 OK):** JSON pengumuman yang berhasil disimpan.

---

## 3. Pengelolaan Data Fundamental Perusahaan (`/v1/financial-reports`)

### 3.1. Input Laporan Keuangan Secara Manual
Memasukkan metrik laporan keuangan mentah untuk emiten secara manual. Sistem otomatis menghitung rasio keuangan utama (EPS, BVPS, ROE, ROA, DER, PER, PBV) berdasarkan data saham saat ini.

*   **Method:** `POST`
*   **Path:** `/v1/financial-reports`
*   **Request Body (JSON):**
    ```json
    {
      "issuerId": "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
      "period": "Q1-2026",
      "periodEndDate": "2026-03-31",
      "revenue": 5000000000,
      "netIncome": 600000000,
      "assets": 12000000000,
      "liabilities": 4000000000,
      "equity": 8000000000,
      "dividendPayout": 150000000, // Opsional
      "source": "manual" // Opsional
    }
    ```
*   **Response (200 OK):** JSON laporan keuangan yang telah disimpan dengan perhitungan rasio terlampir di kolom `ratios`.

### 3.2. Generator Laporan Keuangan Otomatis
Berguna dalam simulasi untuk membuat rangkaian data historis laporan keuangan emiten dengan memproyeksikan pertumbuhan berdasarkan skenario ekonomi tertentu.

*   **Method:** `POST`
*   **Path:** `/v1/financial-reports/generate`
*   **Request Body (JSON):**
    ```json
    {
      "issuerId": "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
      "startPeriod": "FY2026",
      "periods": 4, // Jumlah periode tahunan yang ingin dibuat (1 - 12)
      "baseRevenue": 10000000000, // Pendapatan dasar awal
      "revenueGrowthRate": 0.08, // Laju pertumbuhan pendapatan, default 0.08 (8%)
      "netMargin": 0.12, // Persentase profit margin, default 0.12 (12%)
      "assetToRevenueRatio": 1.8, // default 1.8
      "liabilityToAssetRatio": 0.45, // default 0.45
      "dividendPayout": 0.25, // default 0.25 (25%)
      "scenario": "base" // Skenario pertumbuhan: "bull" | "base" | "bear"
    }
    ```
*   **Response (200 OK):**
    ```json
    {
      "generated": [
        {
          "id": "fd92da8b-c6d9-482a-9e12-32b0a9cd731b",
          "issuerId": "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
          "period": "FY2026-1",
          "revenue": "10800000000.00",
          "netIncome": "1296000000.00",
          "assets": "19440000000.00",
          "liabilities": "8748000000.00",
          "equity": "10692000000.00",
          "eps": "1.3000",
          "bookValuePerShare": "10.6920",
          "dividendPayout": "0.25",
          "ratios": {
            "roe": 0.121212,
            "roa": 0.066666,
            "debtToEquity": 0.818181,
            "netMargin": 0.12,
            "per": 92.3,
            "pbv": 11.22
          },
          "source": "generated"
        }
        // ... laporan keuangan periode berikutnya
      ]
    }
    ```

---

## 4. Pengelolaan Aturan Perdagangan & Sesi (`/v1/rules` & `/v1/sessions`)

### 4.1. Membuat Profil Aturan Perdagangan (Trading Rule Profile)
Profil aturan menampung sekumpulan regulasi (fraksi harga, ukuran lot, ARA/ARB) untuk papan pencatatan tertentu.

*   **Method:** `POST`
*   **Path:** `/v1/rules/profiles`
*   **Request Body (JSON):**
    ```json
    {
      "name": "Main Board Standard Profile",
      "board": "main",
      "marketSegment": "regular",
      "isDefault": false,
      "metadata": {}
    }
    ```
*   **Response (200 OK):** Objek profil aturan baru.

### 4.2. Menambahkan Aturan Lot Size (Lot Size Rule)
Menentukan jumlah lembar saham per 1 lot dalam perdagangan.

*   **Method:** `POST`
*   **Path:** `/v1/rules/lot-sizes`
*   **Request Body (JSON):**
    ```json
    {
      "profileId": "profile-uuid",
      "instrumentType": "stock",
      "lotSize": 100, // 1 lot = 100 lembar
      "effectiveDate": "2026-06-17" // Opsional
    }
    ```

### 4.3. Menambahkan Aturan Tick Size (Tick Size Rule)
Menentukan fraksi perubahan harga naik/turun yang sah berdasarkan rentang harga saham.

*   **Method:** `POST`
*   **Path:** `/v1/rules/tick-sizes`
*   **Request Body (JSON):**
    ```json
    {
      "profileId": "profile-uuid",
      "minPrice": 50, // Harga minimum rentang
      "maxPrice": 200, // Harga maksimum rentang (opsional, jika kosong dianggap open-ended)
      "tickSize": 1 // Perubahan harga kelipatan 1 rupiah
    }
    ```

### 4.4. Menambahkan Aturan Price Band (ARA/ARB)
Menentukan batas persentase Auto Rejection Atas (ARA) dan Auto Rejection Bawah (ARB) untuk membatasi pergerakan harga harian.

*   **Method:** `POST`
*   **Path:** `/v1/rules/price-bands`
*   **Request Body (JSON):**
    ```json
    {
      "profileId": "profile-uuid",
      "minReferencePrice": 50,
      "maxReferencePrice": 200, // Opsional
      "araPercent": 35.0, // Batas kenaikan maksimum 35%
      "arbPercent": 15.0, // Batas penurunan maksimum 15%
      "minPrice": 50 // Batas harga terendah di pasar
    }
    ```

### 4.5. Menambahkan Aturan Batas Volume Order (Auto Rejection Volume)
Membatasi jumlah lot maksimum yang diperbolehkan dalam sekali input order agar tidak merusak likuiditas pasar.

*   **Method:** `POST`
*   **Path:** `/v1/rules/auto-rejections`
*   **Request Body (JSON):**
    ```json
    {
      "profileId": "profile-uuid",
      "maxLotsPerOrder": 10000, // Maksimal 10.000 lot per order
      "maxListedSharesPercent": 0.5 // Maksimal 0.5% dari jumlah saham beredar (opsional)
    }
    ```

### 4.6. Membuat Template Sesi Perdagangan (Session Template)
Template ini menyimpan metadata dasar sesi perdagangan utama bursa.

*   **Method:** `POST`
*   **Path:** `/v1/sessions/templates`
*   **Request Body (JSON):**
    ```json
    {
      "name": "Sesi Pagi Utama",
      "status": "closed", // Pilihan status awal: "closed" | "pre_open" | "opening_auction" | "continuous" | dll.
      "settlementMode": "end_of_session", // Pilihan: "instant" | "end_of_session" | "t_plus_1_session" | "t_plus_n_session"
      "settlementDelaySessions": 0,
      "postClosingEnabled": false,
      "isActive": true,
      "metadata": {}
    }
    ```

### 4.7. Menambahkan Segmen Durasi ke Template Sesi (Session Segment)
Membagi sesi template ke dalam segmen-segmen waktu dengan hak aksi tertentu.

*   **Method:** `POST`
*   **Path:** `/v1/sessions/segments`
*   **Request Body (JSON):**
    ```json
    {
      "templateId": "template-uuid",
      "sequence": 1, // Urutan eksekusi segmen
      "status": "pre_open", // Status pasar pada segmen ini
      "durationSeconds": 300, // Durasi segmen aktif dalam detik
      "allowOrderEntry": false, // Apakah boleh melakukan input order
      "allowCancelAmend": false // Apakah boleh melakukan edit/batal order
    }
    ```

### 4.8. Membuat Biaya Transaksi & Skema Pajak (Fee & Tax Schedule)
Konfigurasi persentase komisi, fee kliring, pajak penjualan, serta PPN.

*   **Method:** `POST`
*   **Path:** `/v1/fee-schedules`
*   **Request Body (JSON):**
    ```json
    {
      "name": "Skema Tarif BEI Standard 2026",
      "brokerBuyRate": 0.0015, // Komisi broker beli (0.15%)
      "brokerSellRate": 0.0025, // Komisi broker jual (0.25%)
      "exchangeFeeRate": 0.0004, // Levy bursa (0.04%)
      "clearingFeeRate": 0.0001, // Kliring KPEI (0.01%)
      "settlementFeeRate": 0.0001, // Penyelesaian KSEI (0.01%)
      "guaranteeFundRate": 0.00001, // Jaminan KPEI (0.001%)
      "vatRate": 0.11, // PPN (11%)
      "sellTaxRate": 0.001, // PPh final jual (0.1%)
      "minimumFee": 5000, // Biaya minimum transaksi dalam rupiah
      "effectiveDate": "2026-06-17",
      "isActive": true
    }
    ```

### 4.9. Mengaktifkan Suspensi Seluruh Market (Trading Halt / Circuit Breaker)
Digunakan untuk menghentikan perdagangan seluruh saham di bursa secara mendadak karena kondisi darurat.

*   **Method:** `POST`
*   **Path:** `/v1/trading-halts`
*   **Request Body (JSON):**
    ```json
    {
      "securityId": null, // Diisi null untuk menghentikan seluruh bursa, atau UUID saham tertentu jika suspensi parsial
      "status": "active", // "active" (mulai halt) atau "inactive" (selesai halt)
      "reason": "Darurat: Indeks bursa anjlok lebih dari 10% dalam 1 sesi.",
      "startedAt": "2026-06-17T12:00:00Z", // Opsional
      "endedAt": null, // Opsional
      "metadata": {}
    }
    ```

---

## 5. Pengelolaan Keanggotaan Broker (`/v1/brokers`)

### 5.1. Mendaftarkan Anggota Broker Baru
Mendaftarkan perusahaan efek / broker sebagai partisipan perdagangan di BEI.

*   **Method:** `POST`
*   **Path:** `/v1/brokers`
*   **Request Body (JSON):**
    ```json
    {
      "code": "MDLA",
      "name": "Mandala Sekuritas",
      "status": "active", // Pilihan: "active" | "inactive" | "suspended"
      "serviceIdentifier": "mandala-sekuritas-core-backend", // Identifier endpoint sistem broker
      "metadata": {}
    }
    ```

### 5.2. Mengubah Status Anggota Broker
Admin dapat menangguhkan aktivitas broker tertentu.

*   **Method:** `PATCH`
*   **Path:** `/v1/brokers/:code/status`
*   **Params:** `code` (Kode broker, e.g. `MDLA`)
*   **Request Body (JSON):**
    ```json
    {
      "status": "suspended",
      "reason": "Sedang dalam audit kepatuhan modal kerja bersih disesuaikan (MKBD)."
    }
    ```
*   **Response (200 OK):** Objek broker dengan status terupdate.

---

## 6. Pemrosesan Settlement Akhir Sesi (`/v1/settlement`)

Endpoint ini biasanya dipanggil setelah sesi market dideklarasikan selesai (`closed`).
*   **Scope Spesifik:** `settlement:write` (atau `admin:*`).

### 6.1. Membuat Batch Settlement Baru
Menganalisis seluruh transaksi (*trades*) yang terjadi di sesi terpilih dan menghasilkan instruksi kliring (instruksi RVP untuk perpindahan dana kas, instruksi DVP untuk perpindahan saham).

*   **Method:** `POST`
*   **Path:** `/v1/settlement/batches`
*   **Request Body (JSON):**
    ```json
    {
      "sessionId": "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", // ID Sesi Perdagangan
      "mode": "end_of_session", // Pilihan: "instant" | "end_of_session" | dll.
      "scheduledFor": "2026-06-17T13:00:00Z" // Opsional
    }
    ```
*   **Response (200 OK):**
    ```json
    {
      "batch": {
        "id": "c71a9e32-2d14-4670-bbcf-29e846dc75ba",
        "sessionId": "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
        "mode": "end_of_session",
        "status": "pending",
        "scheduledFor": "2026-06-17T13:00:00.000Z",
        "createdAt": "2026-06-17T12:30:00.000Z"
      },
      "tradeCount": 142 // Jumlah trade dalam sesi ini yang akan diselesaikan
    }
    ```

### 6.2. Mengeksekusi Perpindahan Saldo Efek & Kas (Process Settlement)
Menjalankan dan meresmikan instruksi pemindahan kepemilikan kas & saham yang ada di dalam batch. Setelah proses sukses, saldo akhir investor akan bertambah/berkurang di *custody ledger* BEI, dan notifikasi webhook dikirim ke server Sekuritas untuk update portofolio pemain.

*   **Method:** `POST`
*   **Path:** `/v1/settlement/batches/:id/process`
*   **Params:** `id` (UUID Batch Settlement)
*   **Response (200 OK):**
    ```json
    {
      "id": "c71a9e32-2d14-4670-bbcf-29e846dc75ba",
      "sessionId": "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
      "mode": "end_of_session",
      "status": "settled", // Status berganti menjadi settled
      "scheduledFor": "2026-06-17T13:00:00.000Z",
      "processedAt": "2026-06-17T12:31:00.000Z",
      "createdAt": "2026-06-17T12:30:00.000Z"
    }
    ```

---

## 7. Pengelolaan IPO & Corporate Action (`/v1/ipo-events` & `/v1/corporate-actions`)

### 7.1. Membuat Event Initial Public Offering (IPO) Baru
Mendaftarkan rencana penawaran saham perdana perusahaan baru ke publik.

*   **Method:** `POST`
*   **Path:** `/v1/ipo-events`
*   **Request Body (JSON):**
    ```json
    {
      "issuerId": "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
      "securityId": "e4b3c2d1-5a6b-7c8d-9e0f-1a2b3c4d5e6f", // Opsional
      "offeredShares": 50000000, // Lembar saham ditawarkan
      "offeringPrice": 150, // Harga penawaran per saham
      "bookbuildingStart": "2026-06-01T00:00:00Z",
      "bookbuildingEnd": "2026-06-05T23:59:59Z",
      "subscriptionStart": "2026-06-08T00:00:00Z",
      "subscriptionEnd": "2026-06-12T23:59:59Z",
      "listingDate": "2026-06-17",
      "status": "draft", // "draft" | "bookbuilding" | "offering" | "allocation" | "listed" | "cancelled"
      "metadata": {}
    }
    ```
*   **Response (200 OK):** Objek data IPO yang dibuat.

### 7.2. Mengirimkan Data Pemesanan IPO Investor (Submit Subscription)
Mencatat minat pemesanan saham IPO oleh nasabah broker.

*   **Method:** `POST`
*   **Path:** `/v1/ipo-events/:id/subscriptions`
*   **Params:** `id` (UUID Event IPO)
*   **Request Body (JSON):**
    ```json
    {
      "brokerCode": "MDLA",
      "investorId": "INV-5566",
      "requestedShares": 5000,
      "idempotencyKey": "sub:ipo:mndl:inv-5566"
    }
    ```

### 7.3. Alokasi dan Distribusi Saham IPO (Allocate IPO)
Menghitung penjatahan riil saham IPO berdasarkan rasio tertentu, memindahkan saham ke portofolio nasabah, serta memicu pendebetan dana.

*   **Method:** `POST`
*   **Path:** `/v1/ipo-events/:id/allocate`
*   **Params:** `id` (UUID Event IPO)
*   **Request Body (JSON):**
    ```json
    {
      "allocationRatio": 0.6 // Rasio penjatahan (e.g. disetujui 60% dari jumlah pemesanan)
    }
    ```
*   **Response (200 OK):** Daftar hasil alokasi beserta jumlah lembar saham final yang didapatkan masing-masing investor.

### 7.4. Mendaftarkan Event Aksi Korporasi (Corporate Action)
Membuat rencana pembagian dividen tunai, pemecahan saham (*stock split*), penggabungan saham (*reverse split*), pembagian saham bonus, rights issue, atau pembagian waran.

*   **Method:** `POST`
*   **Path:** `/v1/corporate-actions`
*   **Request Body (JSON):**
    ```json
    {
      "securityId": "e4b3c2d1-5a6b-7c8d-9e0f-1a2b3c4d5e6f",
      "type": "cash_dividend", // Pilihan: "cash_dividend" | "stock_split" | "reverse_split" | "bonus_share" | "rights_issue" | "warrant"
      "status": "draft",
      "title": "Dividen Tunai 2026 PT Mandala Digital",
      "description": "Pembagian dividen tunai dengan besaran Rp12 per lembar saham.",
      "announcementDate": "2026-06-01",
      "recordingDate": "2026-06-10",
      "executionDate": "2026-06-17",
      "cashAmountPerShare": 12.00, // Diperlukan untuk cash_dividend
      "ratioNumerator": null, // Diperlukan untuk split/bonus/rights (e.g. 2 untuk rasio 1:2)
      "ratioDenominator": null,
      "exercisePrice": null, // Diperlukan untuk rights/warrant
      "idempotencyKey": "ca:div:mndl:2026"
    }
    ```
*   **Response (200 OK):** Objek rencana aksi korporasi yang disimpan.

### 7.5. Mengeksekusi Aksi Korporasi (Process Corporate Action)
*   **Scope Spesifik:** `corporate-action:write` (atau `admin:*`).
*   Mengambil snapshot kepemilikan saham pada tanggal pencatatan, menghitung hak (*entitlement*) masing-masing investor, menyuntikkan dana kas/saham baru ke *custody ledger*, serta memicu webhook update portofolio ke Sekuritas.

*   **Method:** `POST`
*   **Path:** `/v1/corporate-actions/:id/process`
*   **Params:** `id` (UUID Corporate Action)
*   **Response (200 OK):**
    ```json
    {
      "corporateAction": {
        "id": "b968a35e-04f7-41ab-8c9d-d8e23f04ab12",
        "status": "completed",
        "updatedAt": "2026-06-17T12:45:00.000Z"
      },
      "generatedLedgerEntries": 1540, // Jumlah pencatatan ledger baru yang disuntikkan
      "webhookEntitlements": 1540 // Jumlah investor terimbas yang dinotifikasi ke Sekuritas
    }
    ```

---

## 8. Pengawasan Transaksi (Market Surveillance)

*   **Scope Spesifik:** `surveillance:write` (atau `admin:*`).

### 8.1. Menjalankan Pemindaian Pola Transaksi Tidak Wajar (Surveillance Scan)
Memindai transaksi perdagangan pada sesi terpilih untuk mendeteksi pola transaksi tidak wajar seperti lonjakan/penurunan ekstrem (>15% dari referensi), volume tidak wajar (3x lipat volume rata-rata), transaksi pencucian uang (*wash trade* / investor beli & jual sama), serta dominasi akun bot.

*   **Method:** `POST`
*   **Path:** `/v1/surveillance/scan/:sessionId`
*   **Params:** `sessionId` (String ID Sesi)
*   **Response (200 OK):**
    ```json
    {
      "generated": [
        {
          "id": "e09a3dc8-a89c-4eb2-a1f3-2c1a84f3eb54",
          "sessionId": "SESSION-1",
          "type": "wash_trade_signal",
          "severity": "high",
          "message": "MNDL has same investor on buy and sell side",
          "evidence": {
            "symbol": "MNDL",
            "buy_investor_id": "INV-9999",
            "sell_investor_id": "INV-9999",
            "count": 4
          },
          "status": "open",
          "createdAt": "2026-06-17T12:50:00.000Z"
        }
      ]
    }
    ```

---

## 9. Pemantauan & Laporan (GET / Read Endpoints)

Admin bursa dapat menggunakan endpoint berikut untuk memantau status sistem, melihat hasil kliring, mengunduh laporan aktivitas, serta menganalisis kepemilikan saldo efek.

### 9.1. Melihat Daftar Seluruh Broker
*   **Method:** `GET`
*   **Path:** `/v1/brokers`
*   **Response (200 OK):** Array objek broker anggota bursa.

### 9.2. Detail Laporan Keuangan per Emiten
*   **Method:** `GET`
*   **Path:** `/v1/issuers/:issuerId/financial-reports`
*   **Params:** `issuerId` (UUID Emiten)
*   **Response (200 OK):** Daftar laporan keuangan historis untuk emiten tersebut.

### 9.3. Melihat Riwayat Notasi Khusus Saham
*   **Method:** `GET`
*   **Path:** `/v1/securities/:symbol/notations`
*   **Params:** `symbol` (Kode saham)
*   **Response (200 OK):** Daftar seluruh notasi khusus yang pernah diberikan pada saham.

### 9.4. Melihat Riwayat Pengumuman Emiten
*   **Method:** `GET`
*   **Path:** `/v1/issuers/:issuerId/announcements`
*   **Params:** `issuerId` (UUID Emiten)
*   **Response (200 OK):** Daftar pengumuman emiten terurut dari yang terbaru.

### 9.5. Laporan Transaksi per Sesi (Trade Report)
*   **Method:** `GET`
*   **Path:** `/v1/reports/trades/:sessionId`
*   **Params:** `sessionId` (ID Sesi)
*   **Response (200 OK):** Daftar seluruh transaksi matched yang terdaftar secara resmi di BEI untuk sesi tersebut.

### 9.6. Laporan Status Settlement per Sesi (Settlements Report)
*   **Method:** `GET`
*   **Path:** `/v1/reports/settlements/:sessionId`
*   **Params:** `sessionId` (ID Sesi)
*   **Response (200 OK):** Ringkasan instruksi settlement per jenis status (pending/settled) dan total volume uang/saham yang diproses.

### 9.7. Laporan Biaya Transaksi & Pajak (Fee & Tax Report)
*   **Method:** `GET`
*   **Path:** `/v1/reports/fee-tax/:sessionId`
*   **Params:** `sessionId` (ID Sesi)
*   **Response (200 OK):** Rincian fee transaksi (broker buy/sell fee, levy bursa, PPN, dan PPh final) per transaksi di sesi tersebut.

### 9.8. Laporan Ikhtisar Pasar per Sesi (Market Summary Report)
*   **Method:** `GET`
*   **Path:** `/v1/reports/market-summary/:sessionId`
*   **Params:** `sessionId` (ID Sesi)
*   **Response (200 OK):** Ringkasan statistik pasar (OHLC, volume, frekuensi, nilai transaksi) beserta daftar Top Gainers, Top Losers, dan Most Active.

### 9.9. Laporan Riwayat Aksi Korporasi
*   **Method:** `GET`
*   **Path:** `/v1/reports/corporate-actions`
*   **Response (200 OK):** Daftar riwayat eksekusi seluruh aksi korporasi yang terdaftar di bursa.

### 9.10. Riwayat Mutasi Saldo Efek & Kas (Custody Movements)
Melihat data entri mutasi saldo pada ledger kustodian BEI secara append-only.
*   **Method:** `GET`
*   **Path:** `/v1/reports/custody-movements`
*   **Query Params:** `limit` (angka, default 100)
*   **Response (200 OK):**
    ```json
    [
      {
        "id": "e0a7f76c-389d-4c33-b9cd-99b8b32c667a",
        "custodyAccountId": "ac0de234-4b5b-4c22-b5e2-6cc7f80ab234",
        "securityId": "e4b3c2d1-5a6b-7c8d-9e0f-1a2b3c4d5e6f",
        "entryType": "trade_settlement",
        "assetType": "security",
        "quantity": "500.0000",
        "cashAmount": "0.00",
        "positionState": "settled",
        "referenceType": "settlement_instruction",
        "referenceId": "inst:settle:123",
        "idempotencyKey": "ledger:inst:settle:123:buyer-security",
        "createdAt": "2026-06-17T12:31:00.000Z"
      }
    ]
    ```

### 9.11. Rekonsiliasi Saldo Investor (Reconciliation)
Melihat rangkuman posisi kas dan saham final investor tertentu berdasarkan catatan kustodian BEI.
*   **Method:** `GET`
*   **Path:** `/v1/reconciliation/:brokerCode/:investorId`
*   **Params:**
    *   `brokerCode` (e.g. `MDLA`)
    *   `investorId` (e.g. `INV-5566`)
*   **Response (200 OK):**
    ```json
    {
      "account": {
        "id": "ac0de234-4b5b-4c22-b5e2-6cc7f80ab234",
        "brokerId": "br-uuid",
        "investorId": "INV-5566",
        "sid": "SID12345",
        "sre": "SRE12345",
        "rdn": "RDN12345",
        "status": "active"
      },
      "positions": [
        {
          "security_id": null,
          "symbol": null,
          "asset_type": "cash",
          "quantity": "0.0000",
          "cash_amount": "25000000.00" // Saldo kas RDN investor
        },
        {
          "security_id": "e4b3c2d1-5a6b-7c8d-9e0f-1a2b3c4d5e6f",
          "symbol": "MNDL",
          "asset_type": "security",
          "quantity": "1500.0000", // Jumlah saldo saham MNDL
          "cash_amount": "0.00"
        }
      ]
    }
    ```

### 9.12. Melihat Riwayat Alert Pengawasan (Surveillance Alerts)
Melihat log alarm transaksi mencurigakan hasil pemindaian sistem surveillance.
*   **Method:** `GET`
*   **Path:** `/v1/surveillance/alerts`
*   **Query Params:**
    *   `status` (opsional, e.g. `open`)
    *   `limit` (angka, default 100)
*   **Response (200 OK):** Array objek surveillance alert.

