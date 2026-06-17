# BEI Architecture V2 (Event-Driven & OpenAPI)

Dokumen ini menjelaskan perubahan arsitektur pada ekosistem Mandala Exchange menuju otomatisasi penuh (Fase V2).

## 1. Standardisasi API (OpenAPI)
Semua tipe data kontrak inti (`Order`, `Trade`, `SessionStatus`, dll) kini didefinisikan secara terpusat di `Mandala-Exchange/openapi.yaml`.
Proyek BEI dan SEKURITAS (berbasis TypeScript) menggunakan `openapi-typescript` untuk melakukan *generate* tipe data secara otomatis ke dalam `src/types/api.d.ts`. Hal ini memastikan tidak ada perbedaan tipe data antara *backend* Go (MATS) dan *backend/frontend* Node.js.

## 2. Event-Driven via Redis Pub/Sub
BEI tidak lagi mengandalkan sistem *polling* pasif dari MATS.
- **Publisher**: Setiap kali admin/sistem mengubah aturan bursa, harga acuan, atau *state* sesi pasar, BEI akan mengirimkan (publish) pesan *event* ke *channel* Redis `market_updates`.
- **Subscriber**: MATS yang terus mendengarkan *channel* tersebut akan langsung memperbarui *cache in-memory* seketika itu juga (real-time).

## 3. Otomatisasi (Auto-Settlement & Circuit Breaker)
- **Auto-Settlement**: BEI mendengarkan *event* perpindahan sesi ke `closed` (baik via Webhook MATS atau Pub/Sub). Saat terjadi, BEI akan otomatis membuat *batch settlement* dari seluruh *trade* yang terjadi pada hari itu dan mengeksekusinya tanpa perlu intervensi REST API admin.
- **Circuit Breaker**: Modul *Surveillance* akan mengecek pergerakan harga agregat. Jika terdeteksi penurunan IHSG simulasi melebihi batas (misal >10%), BEI akan memicu `POST /v1/admin/session/halt` ke MATS.
