# 🌌 Mandala Exchange Ecosystem

[![Go Version](https://img.shields.io/badge/Go-1.20%2B-00ADD8?style=for-the-badge&logo=go&logoColor=white)](https://golang.org)
[![Node.js Version](https://img.shields.io/badge/Node.js-18%2B-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![React](https://img.shields.io/badge/React-18.0-61DAFB?style=for-the-badge&logo=react&logoColor=black)](https://react.dev)
[![Fastify](https://img.shields.io/badge/Fastify-4.0-000000?style=for-the-badge&logo=fastify&logoColor=white)](https://www.fastify.io)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15-4169E1?style=for-the-badge&logo=postgresql&logoColor=white)](https://www.postgresql.org)
[![Docker](https://img.shields.io/badge/Docker-Container-2496ED?style=for-the-badge&logo=docker&logoColor=white)](https://www.docker.com)

Selamat datang di repositori **Mandala Exchange**, platform simulasi perdagangan efek terintegrasi yang mensimulasikan ekosistem bursa saham sesungguhnya di Indonesia. Proyek ini dibagi menjadi tiga domain layanan utama guna memastikan pemisahan batas tanggung jawab (*system boundary*) yang jelas dan performa perdagangan yang optimal.

---

## 📸 Tampilan Dashboard & Pasar Saham

Dapatkan visualisasi real-time pasar saham dan antarmuka premium Mandala Exchange:

| Landing Page | Dashboard Utama | Pasar Saham |
| :---: | :---: | :---: |
| ![Landing Page](./docs/images/landing.png) | ![Dashboard](./docs/images/dashboard.png) | ![Pasar Saham](./docs/images/pasar_saham.png) |

---

## 🏛️ Arsitektur Sistem & Alur Data

Ekosistem Mandala Exchange dirancang dengan arsitektur mikro (*microservices*) berkinerja tinggi. Berikut adalah visualisasi alur interaksi runtime antar layanan:

```mermaid
graph TD
    %% Subgraphs
    subgraph Client_Broker["Broker & Client Layer (SEKURITAS)"]
        SEK_FE["💻 Sekuritas Frontend<br>(React + Vite)"]
        SEK_BE["⚙️ Sekuritas Backend<br>(Fastify + TS)"]
        SEK_FE <-->|REST / WebSockets| SEK_BE
    end

    subgraph Matching_Engine["Trading Core Layer (MATS)"]
        MATS["⚡ MATS Service<br>(Go Matching Engine)"]
    end

    subgraph Market_Authority["Market Authority Layer (BEI)"]
        BEI["🏛️ BEI Service<br>(Fastify + TS)"]
    end

    %% Interactions
    SEK_BE -->|1. Submit Order| MATS
    MATS -->|2. Validate Rules| BEI
    MATS -->|3. Capture Trade| BEI
    SEK_BE <-->|4. Real-time Market Data| MATS
    SEK_BE -->|5. Custody & Settlement| BEI

    %% Databases
    subgraph Storage["Databases & Caches"]
        BEI_DB[("🗄️ BEI DB<br>(PostgreSQL)")] <--> BEI
        MATS_DB[("🗄️ MATS DB<br>(PostgreSQL & Redis)")] <--> MATS
        SEK_DB[("☁️ Sekuritas DB<br>(Neon Postgres)")] <--> SEK_BE
    end

    %% Styling
    classDef beiStyle fill:#FFF0F0,stroke:#FF5A5A,stroke-width:2px,color:#900;
    classDef matsStyle fill:#F0FFF0,stroke:#28A745,stroke-width:2px,color:#060;
    classDef sekStyle fill:#F0F8FF,stroke:#007BFF,stroke-width:2px,color:#005;
    classDef dbStyle fill:#F5F5F5,stroke:#888,stroke-width:2px,color:#333;

    class BEI,BEI_DB beiStyle;
    class MATS,MATS_DB matsStyle;
    class SEK_FE,SEK_BE,SEK_DB sekStyle;
    class Storage dbStyle;
```

---

## 📂 Struktur Repositori & Boundary Sistem

Repositori ini terorganisasi berdasarkan tanggung jawab fungsional masing-masing komponen:

| Modul | Deskripsi Peran / Boundary | Tautan Dokumentasi |
| :--- | :--- | :---: |
| **🏛️ BEI** | Market Authority. Mengelola master emiten, trading rules, broker member, trade capture, settlement, custody ledger, corporate action, reporting, dan surveillance. | [README.md](./BEI/README.md) |
| **⚡ MATS** | Mandala Automated Trading System. Mengelola order book (in-memory), continuous matching engine, validasi rules BEI, trade generation, dan distribusi market data realtime via WebSockets. | [README.md](./MATS/README.md) |
| **💼 SEKURITAS** | Mandala Sekuritas. Mengelola user/player, cash reservation, share reservation, order entry gateway, portofolio, leaderboards, dan antarmuka web trader. | [README.md](./SEKURITAS/README.md) |
| **🤖 BOT** | Automated trading investor. Bertindak sebagai penyedia likuiditas pasar, wajib masuk melalui gerbang Sekuritas (tunduk pada aturan pasar). | [PRD Dokumen](./docs/BOT/BOT_PRD.md) |

---

## 🌐 Konfigurasi Port Layanan

Semua modul dikonfigurasi untuk berjalan berdampingan pada port berikut:

| Layanan | Mode Development | Mode Production | Deskripsi |
| :--- | :--- | :--- | :--- |
| **Sekuritas Frontend** | `http://localhost:5173` | `http://localhost:4174` | Antarmuka pengguna (trader portal) |
| **Sekuritas Backend** | `http://localhost:3002` | `http://localhost:3003` | REST API Broker & Portofolio |
| **MATS Service** | `http://localhost:8082` | `http://localhost:8083` | HTTP API & WebSocket Market Data |
| **BEI Service** | `http://localhost:4100` | `http://localhost:4101` | REST API Authority & Admin Console |

---

## 🚀 Panduan Memulai Cepat (Quick Start)

Kami telah menyediakan skrip batch `start-all.bat` untuk meluncurkan seluruh lingkungan pengembangan dalam sekali perintah di sistem operasi Windows.

### Prasyarat
Pastikan Anda sudah menginstal aplikasi berikut:
- **GoLang** (versi 1.20+)
- **Node.js** (versi 18+)
- **Docker Desktop** (untuk PostgreSQL lokal & Redis)

### Langkah Inisialisasi

1. **Jalankan Skrip Startup Global:**
   ```bash
   # Jalankan dalam mode Development (Rekomendasi untuk testing lokal)
   start-all.bat development

   # Atau jalankan dalam mode Production (Dengan Cloudflare Tunnel)
   start-all.bat production
   ```
   *Skrip ini secara otomatis akan menjalankan Docker Containers, menjalankan migrasi database, melakukan seeding data awal BEI, dan meluncurkan semua dev server dalam jendela CMD terpisah.*

2. **Akses Dashboard:**
   - Trader Web App: `http://localhost:5173`
   - BEI Admin Console: `http://localhost:4100/admin`

---

## 🛡️ Kebijakan Keamanan Internal

Komunikasi antar-layanan diproteksi menggunakan **Service-to-Service Token Passing**. Setiap request internal wajib menyertakan header token berikut:
```http
x-service-token: <secure-service-token>
```
Detail token dan lingkup otorisasi (*scopes*) dapat ditemukan di masing-masing folder dokumentasi [BEI](./BEI/README.md) dan [MATS](./MATS/README.md).
