# MATS Matching Engine

## Deskripsi Umum
Fitur ini adalah jantung dari layanan **MATS (Mandala Automated Trading System)**, yang bertugas menerima pesanan (order) saham, melakukan validasi terhadap aturan BEI (seperti fraksi harga dan status broker), menjaga *Order Book* di dalam memori (*in-memory*), serta melakukan pencocokan (*matching*) pesanan yang menghasilkan transaksi (trades).

## Komponen Utama & Logika

- **Orders Service** ([service.go](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/MATS/internal/orders/service.go#L107-L207)):
  Layanan gerbang awal (gateway) yang memproses permintaan `Place`, `Amend`, dan `Cancel`.
  - **Idempotency**: Mencegah duplikasi eksekusi pada order ID yang sama melalui fungsi hash payload `idempotencyKey` yang disimpan di database ([service.go](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/MATS/internal/orders/service.go#L554-L571)).
  - **Validation**: Mengecek keabsahan broker lewat API internal BEI (`brokerValidator`) dan memastikan harga/quantitas memenuhi profil aturan yang aktif.

- **Matching Engine** ([engine.go](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/MATS/internal/matching/engine.go#L59-L84)):
  Memegang *Order Book* untuk setiap saham dan memproses *Continuous Matching*.
  - Fungsi `Place` akan menempatkan pesanan dan mengembalikan array `Trade` jika ada persilangan harga (cross) dengan order yang sedang *resting* (menunggu) di buku. 
  - Jika sesi merupakan sesi pelelangan (Auction Collection), order tidak akan langsung dicocokkan tetapi statusnya diset terbuka `PlaceAuction` dan ditahan di buku ([engine.go](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/MATS/internal/matching/engine.go#L86-L93)).

- **Auction Uncross** ([engine.go](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/MATS/internal/matching/engine.go#L205-L230)):
  Saat sesi pelelangan (Pre-Open atau Pre-Close) berakhir, fungsi `UncrossAuction` dipanggil. Ini akan mencari harga ekuilibrium dan menghasilkan transaksi lelang serentak (*batch trades*).

## Alur Kerja (Workflow)

1. **Order Masuk:** Diterima lewat HTTP handler, lalu masuk ke `orders.Service.Place`. Diimplementasikan di ([service.go](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/MATS/internal/orders/service.go#L107)).
2. **Validasi:** `Service` memeriksa *idempotency*, status broker, serta fraksi harga/lot via layanan *rules*.
3. **Matching:** Order diteruskan ke `matching.Engine.Place`. Buku pesanan (`Book`) mengkalkulasi kemungkinan *trade*. Diimplementasikan di ([engine.go](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/MATS/internal/matching/engine.go#L59)).
4. **Penyimpanan:** *Trade* dan status perubahan *Order* disimpan secara atomik/persistence (beserta Event Logging). Diimplementasikan di ([service.go](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/MATS/internal/orders/service.go#L190-L196)).
5. **Broadcasting:** Jika ada *Trade* atau perubahan di buku, akan diterbitkan via Event Dispatcher ke WebSocket Market Data. Diimplementasikan di ([service.go](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/MATS/internal/orders/service.go#L446-L462)).

## Daftar File yang Terlibat
- [service.go](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/MATS/internal/orders/service.go) - Orkestrator logika pemesanan yang menghubungkan validasi, engine, dan persistence.
- [engine.go](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/MATS/internal/matching/engine.go) - Inti struktur *in-memory* engine untuk proses matching order.
- [book.go](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/MATS/internal/matching/book.go) - (Tidak ditelusuri mendalam tapi esensial) Struktur antrian Bids & Asks berdasarkan aturan Price-Time Priority.
