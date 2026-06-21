# MATS Market Data (WebSocket)

## Deskripsi Umum
Fitur ini adalah saluran distribusi utama informasi pasar (Market Data) dari sistem MATS ke layanan hilir (seperti aplikasi broker/Sekuritas). Fitur ini mendistribusikan aliran data secara seketika (*real-time*) lewat WebSocket. Ini mencakup pembaruan *Depth Snapshot* (Order Book), ringkasan harga (Market Summary), harga indikatif selama lelang, serta informasi pergantian status sesi perdagangan.

## Komponen Utama & Logika

- **WebSocket Hub & Connection Manager** ([ws.go](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/MATS/internal/marketdata/ws.go#L36-L54)):
  Terdapat sebuah pusat perutean pesan (Hub) yang mendaftarkan dan membuang koneksi WebSocket (clients). Hub ini mendukung *subscribing* spesifik per saham berbekal *query parameter* `?symbols=...`. Jika klien tak menyediakan daftar simbol khusus, maka akan menerima seluruh pembaruan (Firehose).

- **Initial Snapshots** ([ws.go](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/MATS/internal/marketdata/ws.go#L124-L174)):
  Saat klien pertama kali terhubung (`register`), sistem segera mengirimkan status sesi (Session State), kondisi kedalaman buku (*Depth Snapshot*), serta harga terakhir (*Last Price*) agar aplikasi *frontend* klien dapat melakukan sinkronisasi *state* seketika.

- **Event Broadcasting & Write Loop** ([ws.go](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/MATS/internal/marketdata/ws.go#L63-L88)):
  `Publish` memancarkan *Event* berseri (`Sequence`) kepada *channel* (buffered chan) dari klien terkait secara paralel. Sementara goroutine `writeLoop` ([ws.go](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/MATS/internal/marketdata/ws.go#L176-L196)) secara terus-menerus membaca pesan di *channel* dan menuliskannya ke koneksi jaringan. Goroutine ini juga menangani mekanisme detak jantung (*heartbeat*) tiap 15 detik untuk menjaga agar koneksi tidak diputus oleh balancer/firewall.

## Alur Kerja (Workflow)

1. **Inisiasi Klien:** Klien terhubung melalui `GET /v1/market-data/ws`. Permintaan dinaikkan (Upgrade) menjadi koneksi WebSocket. Diimplementasikan di ([ws.go](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/MATS/internal/marketdata/ws.go#L90-L108)).
2. **Synchronize:** Sistem mendorong data status terbaru saat itu juga kepada klien yang baru terkoneksi. Diimplementasikan di ([ws.go](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/MATS/internal/marketdata/ws.go#L124)).
3. **Continuous Streaming:** Matching Engine men-trigger pembaruan pada Hub setelah setiap modifikasi Order Book. Hub membroadcast data ini kepada klien yang berlangganan. Diimplementasikan di ([ws.go](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/MATS/internal/marketdata/ws.go#L63)).
4. **Heartbeat:** `writeLoop` menembak payload `{ "type": "heartbeat", "payload": { "status": "ok" } }` secara rutin. Diimplementasikan di ([ws.go](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/MATS/internal/marketdata/ws.go#L191)).

## Daftar File yang Terlibat
- [ws.go](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/MATS/internal/marketdata/ws.go) - Pusat implementasi WebSocket, menangani koneksi *client* dan perutean (routing) aliran data.
