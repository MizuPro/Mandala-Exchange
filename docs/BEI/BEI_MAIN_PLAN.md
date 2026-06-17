# Main Implementation Plan - BEI Service

## Fase 1: Kontrak Domain & Arsitektur
- **Status**: [x] Selesai
- **Tugas**:
  - [x] Task 1.1: Tetapkan batas tanggung jawab BEI, MATS, Sekuritas, dan Bot.
  - [x] Task 1.2: Definisikan entity inti: issuer, issuer_announcement, listed_security, listing_board, special_notation, broker_member, trading_rule, price_band_rule, fee_schedule, market_index, trade, settlement_batch, settlement_instruction, custody_account, custody_ledger_entry, corporate_action.
  - [x] Task 1.3: Definisikan event/API contract internal untuk MATS dan Sekuritas.
  - [x] Task 1.4: Definisikan enum status untuk listed/suspended/delisted, board type, special notation, settlement instruction type, settlement status, corporate action status, trading halt status, dan session status.
- **Catatan**: Fase ini menjadi dasar sebelum implementasi database dan API.

## Fase 2: Inisialisasi Service & Database
- **Status**: [x] Selesai
- **Tugas**:
  - [x] Task 2.1: Buat struktur project BEI Service dengan Node.js + Fastify + TypeScript.
  - [x] Task 2.2: Pilih dan konfigurasi query layer ringan, disarankan Drizzle ORM atau Kysely.
  - [x] Task 2.3: Konfigurasi PostgreSQL via Docker Compose untuk database BEI.
  - [x] Task 2.4: Konfigurasi migration, environment variable, seed command, dan local development.
  - [x] Task 2.5: Buat health check endpoint dan basic service authentication.
  - [x] Task 2.6: Siapkan audit log dasar untuk perubahan data penting.
- **Catatan**: Belum perlu frontend admin pada fase ini.

## Fase 3: Master Data Emiten & Saham
- **Status**: [x] Selesai
- **Tugas**:
  - [x] Task 3.1: Implement CRUD issuer/company profile.
  - [x] Task 3.2: Implement CRUD listed securities dengan symbol, board, sector, shares outstanding, status, reference price, dan market mechanism.
  - [x] Task 3.3: Implement special notation/watchlist/suspend marker per saham.
  - [x] Task 3.4: Implement issuer announcement/disclosure sederhana.
  - [x] Task 3.5: Implement endpoint publik/internal untuk daftar saham dan detail emiten.
  - [x] Task 3.6: Buat seed data awal untuk beberapa emiten simulasi.
- **Catatan**: Data awal dapat dibuat manual dan diperbaiki bertahap.

## Fase 4: Fundamental Data & Company Analysis
- **Status**: [x] Selesai
- **Tugas**:
  - [x] Task 4.1: Buat schema laporan keuangan sederhana per periode.
  - [x] Task 4.2: Implement endpoint input, edit, dan read laporan keuangan.
  - [x] Task 4.3: Implement generator otomatis laporan keuangan dengan parameter pertumbuhan, margin, aset, liabilitas, dan skenario bisnis.
  - [x] Task 4.4: Hitung rasio dasar seperti EPS, BVPS, PER, PBV, ROE jika datanya tersedia.
  - [x] Task 4.5: Sediakan API untuk Sekuritas agar frontend dapat menampilkan analisis perusahaan.
- **Catatan**: Rumus dan generator dapat disederhanakan untuk gameplay, tetapi hasilnya harus konsisten antar periode.

## Fase 5: Trading Rules & Session Configuration
- **Status**: [x] Selesai
- **Tugas**:
  - [x] Task 5.1: Implement konfigurasi lot size dengan preset 1 lot = 100 lembar untuk saham.
  - [x] Task 5.2: Implement tick size/fraksi harga, ARA/ARB, price band berbasis reference price, dan auto rejection volume.
  - [x] Task 5.3: Implement reference price management untuk previous close, IPO/listing price, opening price, dan corporate action adjusted price.
  - [x] Task 5.4: Implement konsep market segment: regular sebagai MVP, cash/negotiated sebagai schema-ready.
  - [x] Task 5.5: Implement konfigurasi session duration dan session template termasuk pre-open, opening auction, continuous market, pre-close, random closing, non-cancellation period, post-closing, dan closed.
  - [x] Task 5.6: Implement settlement mode: instant, end-of-session, T+1 session, dan T+N session.
  - [x] Task 5.7: Implement konfigurasi trading halt/circuit breaker dan manual suspend/resume symbol.
  - [x] Task 5.8: Implement market index dan market summary untuk dasar circuit breaker dan dashboard.
  - [x] Task 5.9: Implement fee/tax schedule realistis yang memisahkan broker commission, levy/bursa, clearing, settlement, guarantee fund jika dipakai, PPN, dan PPh final jual.
  - [x] Task 5.10: Sediakan endpoint untuk MATS mengambil rules dan session config.
  - [x] Task 5.11: Sediakan endpoint untuk Sekuritas mengambil fee/tax schedule.
- **Catatan**: Default settlement adalah end-of-session.

## Fase 6: Broker Member Registry
- **Status**: [x] Selesai
- **Tugas**:
  - [x] Task 6.1: Implement registry broker member.
  - [x] Task 6.2: Seed Mandala Sekuritas sebagai broker aktif pertama.
  - [x] Task 6.3: Buat API validasi broker untuk MATS dan Sekuritas.
  - [x] Task 6.4: Tambahkan status active/suspended untuk broker.
- **Catatan**: Struktur harus siap multi-broker walau MVP hanya satu.

## Fase 7: Trade Capture dari MATS
- **Status**: [x] Selesai
- **Tugas**:
  - [x] Task 7.1: Implement endpoint receive trade event dari MATS.
  - [x] Task 7.2: Tambahkan idempotency key dan unique constraint trade id/sequence.
  - [x] Task 7.3: Validasi symbol, session, broker, dan trade payload.
  - [x] Task 7.4: Simpan trade resmi untuk clearing dan reporting.
- **Catatan**: Ini adalah integrasi kritis dengan MATS.

## Fase 8: Clearing, Settlement & Custody Ledger
- **Status**: [x] Selesai
- **Tugas**:
  - [x] Task 8.1: Generate settlement instruction dari trade matched.
  - [x] Task 8.2: Implement tipe instruksi settlement konseptual seperti DVP/RVP/FOP.
  - [x] Task 8.3: Implement settlement batch berdasarkan session dan settlement mode.
  - [x] Task 8.4: Implement custody account, SID/SRE/RDN simulation reference, dan custody ledger entry.
  - [x] Task 8.5: Proses settlement sukses dan update posisi final.
  - [x] Task 8.6: Buat API settlement update untuk Sekuritas.
  - [x] Task 8.7: Buat reconciliation endpoint antara BEI dan Sekuritas.
- **Catatan**: MVP boleh menganggap semua settlement sukses.

## Fase 9: IPO & Corporate Action MVP
- **Status**: [x] Selesai
- **Tugas**:
  - [x] Task 9.1: Implement event IPO sederhana: create, subscription, allocation, listing.
  - [x] Task 9.2: Implement dividend event sederhana.
  - [x] Task 9.3: Implement stock split dan reverse split sederhana.
  - [x] Task 9.4: Implement bonus share sederhana.
  - [x] Task 9.5: Implement rights issue/HMETD sederhana.
  - [x] Task 9.6: Implement warrant sederhana.
  - [x] Task 9.7: Generate ledger/cash movement akibat IPO allocation, dividen, dan corporate action.
  - [x] Task 9.8: Sediakan API corporate action untuk Sekuritas.
- **Catatan**: Semua corporate action MVP boleh sederhana, tetapi wajib mengubah custody ledger/position dengan benar.

## Fase 10: Reporting, Surveillance & Hardening
- **Status**: [x] Selesai
- **Tugas**:
  - [x] Task 10.1: Buat laporan trade per session.
  - [x] Task 10.2: Buat laporan settlement batch dan custody movement.
  - [x] Task 10.3: Tambahkan laporan fee/tax per player, broker, dan session.
  - [x] Task 10.4: Tambahkan laporan market summary, market index, top gainers/losers, dan most active.
  - [x] Task 10.5: Tambahkan surveillance alert dasar untuk price/volume anomaly, ARA/ARB touch, unusual volume, wash-trade sederhana, cancellation rate tinggi, dan dominasi order bot.
  - [x] Task 10.6: Tambahkan integration test dengan MATS dan Sekuritas.
  - [x] Task 10.7: Siapkan konfigurasi deployment via Cloudflare Tunnel.
- **Catatan**: Frontend admin dapat dikerjakan setelah API stabil.

## [V2 / Post-MVP] Status Pelaksanaan

- **Circuit Breaker & Surveillance**: Telah diimplementasikan dan diverifikasi (Tahap 4 pada eksekusi sebelumnya).
- **Sinkronisasi Sesi**: Telah diimplementasikan.
