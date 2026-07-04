# BOT-v2 Fase 5 Implementation Plan

Versi: 1.0  
Tanggal: 2026-07-04  
Status: Siap direview sebelum eksekusi

## 1. Tujuan

Fase 5 membuat IPO menjadi objek dinamis yang dapat ditemukan dan diikuti BOT
tanpa hardcode simbol. Alur yang harus terbukti:

```text
Admin BEI membuat dan mempublikasikan IPO
  -> BOT menemukan IPO publik
  -> IPO Hunter memilih dan subscribe melalui Sekuritas
  -> Sekuritas reserve cash dan meneruskan subscription ke BEI
  -> BEI melakukan allocation
  -> Sekuritas debit/refund cash dan mencatat saham sebagai pending
  -> BEI melakukan listing dan mengaktifkan security
  -> Sekuritas memindahkan saham pending menjadi available
  -> BOT menambah simbol ke universe dan market-data subscription
  -> seluruh strategi melakukan price discovery sesuai profilnya
```

Target akhir:

1. IPO baru terdeteksi tanpa restart dan tanpa mengubah config simbol.
2. Event-Driven/IPO Hunter dapat subscribe secara idempotent.
3. Cash reserve, allocation, refund, pending position, dan listing konsisten.
4. Saham hasil allocation tidak dapat dijual sebelum listed.
5. Simbol listed otomatis masuk universe BOT dan stream market data.
6. Hype dan archetype memengaruhi probabilitas/ukuran keputusan, bukan harga
   secara langsung.
7. Hot IPO dapat bergerak kuat, tetapi tidak deterministik selalu ARA.
8. Data yang digunakan BOT juga tersedia sebagai data publik untuk player.

## 2. Batas Tanggung Jawab

| Layanan | Tanggung jawab Fase 5 |
|---|---|
| BEI | Source of truth lifecycle, metadata publik IPO, allocation, listing, aktivasi security, dan initial fair value |
| Sekuritas | Investor subscription, idempotency, reserve/debit/refund cash, pending/available position, serta account event |
| BOT | Discovery, eligibility, sizing, subscription orchestration, memory, dynamic universe, dan perilaku price discovery |
| MATS | Menerima security/rules aktif dari BEI, menyediakan order book dan market data; tidak mengetahui hype atau strategi BOT |
| Frontend Sekuritas | Menampilkan IPO dan metadata publik yang sama secara prinsip dengan data yang dibaca BOT |

BOT tetap dilarang:

1. Mutasi database layanan lain.
2. Subscribe langsung ke BEI.
3. Mengirim order langsung ke MATS.
4. Membaca draft/future IPO yang belum publik.
5. Mengubah harga karena hype tanpa order nyata.

## 3. Kondisi Implementasi Saat Ini

### 3.1 BEI

Sudah tersedia:

1. Tabel `ipo_events`, `ipo_subscriptions`, dan `ipo_allocations`.
2. Lifecycle status `draft`, `bookbuilding`, `subscription`, `allocation`,
   `listed`, dan `cancelled`.
3. Endpoint create, detail, list, subscribe, cancel, allocate, list, dan cancel.
4. Allocation custody ledger dengan idempotency key.
5. Webhook allocation, listing, cancellation, dan reversal ke Sekuritas.
6. Endpoint BOT `GET /bot/ipo-lifecycle`.

Gap:

1. `GET /bot/ipo-lifecycle` belum memiliki kontrak response eksplisit dan
   memakai `JOIN listed_securities`, sehingga event tanpa `security_id` hilang.
2. Response belum menjamin `id`, symbol, company name, window, lot size,
   hype, archetype, float, sentiment, version, dan initial fair value.
3. `ipo_hype_score` dan `ipo_archetype` belum menjadi data tervalidasi; saat
   ini hanya mungkin ditaruh bebas di `metadata`.
4. Endpoint subscription BEI belum memvalidasi status/window/lot multiple
   sebelum menerima request.
5. Allocation ratio global dapat menghasilkan pecahan yang bukan kelipatan lot
   dan belum membatasi total allocation secara eksplisit terhadap offered shares.
6. Transition `list` hanya mengubah status IPO; belum terbukti mengubah
   `listed_securities.status`, reference price, dan readiness MATS secara atomik.
7. Initial fair value belum dibuat/diaktifkan sebagai bagian lifecycle IPO.
8. Webhook dikirim langsung dan error hanya dicatat; belum ada outbox/retry
   terjamin untuk allocation/listing.

### 3.2 Sekuritas

Sudah tersedia:

1. Endpoint player dan BOT untuk subscription/cancel.
2. Reserve cash atomik dengan kondisi saldo mencukupi.
3. Idempotency key dan deteksi payload conflict.
4. Forward subscription ke BEI.
5. Handler allocation yang melakukan debit aktual, refund sisa reserve,
   dan mencatat saham ke `pending`.
6. Handler listing yang memindahkan `pending` ke `available`.
7. Cancellation/reversal dan event `ipo_subscription_updated` untuk BOT.

Gap:

1. Client BOT tidak mengirim `Idempotency-Key`, sementara endpoint BOT
   mewajibkannya.
2. `SubscribeIPO` tidak mengembalikan `subscription_id`, status, reserve, atau
   error terstruktur sehingga BOT tidak bisa reconcile.
3. Belum ada endpoint lookup/list subscription milik BOT untuk recovery setelah
   timeout/restart.
4. Forward failure dapat meninggalkan status `cash_reserved`; belum ada worker
   retry/reconcile yang jelas.
5. Event allocation nol tidak terkirim karena BEI hanya mengirim webhook jika
   ada allocation row yang dianggap generated dan entitlements security perlu
   ditinjau untuk zero allocation.
6. Handler lifecycle memilih satu subscription per event/account; kontrak perlu
   memutuskan apakah satu account hanya boleh punya satu active subscription.
7. Guard non-negative pada pengurangan reserved/pending/available perlu diuji
   terhadap webhook duplicate dan out-of-order.
8. Snapshot BOT belum mengembalikan daftar subscription IPO aktif sehingga
   restart bergantung penuh pada event replay.

### 3.3 BOT-v2

Sudah tersedia:

1. BEI snapshot memiliki koleksi `IPOs`.
2. Sekuritas client memiliki method subscribe/cancel IPO.
3. Slow poll BEI berjalan saat startup dan `pre_open`.
4. Event-Driven strategy dan shared listed-symbol universe sudah tersedia.
5. Account event stream dapat menerima `ipo_subscription_updated`.

Gap:

1. Model `IPOLifecycle` hanya berisi issuer, offered shares, price, dan status;
   bahkan belum membawa IPO event ID untuk subscription.
2. Tidak ada discovery diff, lifecycle state machine, subscription planner,
   executor, retry/reconcile, atau persistent memory IPO.
3. `ipo_subscription_updated` belum mengubah state IPO khusus dalam registry.
4. Event-Driven hanya bereaksi terhadap news; belum bertindak sebagai
   IPO Hunter saat subscription.
5. Semua strategi belum memiliki attention boost/cooling period IPO.
6. Universe listed memang dibaca dari BEI, tetapi hanya refresh pada startup dan
   `pre_open`; listing intraday tidak langsung terdeteksi.
7. MATS WebSocket memakai daftar simbol statis dari `config.yaml` dan tidak
   mendukung update/reconnect saat simbol baru listed.
8. Belum ada guard agar subscription tidak dihitung sebagai regular session
   order limit.

### 3.4 MATS

MATS tidak memerlukan logic hype. Perubahan Fase 5 dibatasi pada:

1. Memastikan security baru dan reference price dapat disinkronkan dari BEI.
2. Memastikan order untuk symbol baru diterima setelah listed dan ditolak
   sebelumnya.
3. Memastikan WebSocket dapat melayani symbol baru ketika client BOT
   memperbarui filter/reconnect.

## 4. Keputusan Desain yang Direkomendasikan

### 4.1 Discovery: polling versioned sebagai MVP

Gunakan polling `GET /bot/ipo-lifecycle` setiap 10-15 detik dan refresh segera
pada pergantian segment. Jangan menambah message broker pada Fase 5.

Alasan:

1. Infrastruktur saat ini sudah berbasis polling untuk state BEI.
2. Lifecycle IPO tidak membutuhkan latency millisecond.
3. Polling + version + diff lebih sederhana, retryable, dan mudah dites.
4. Event streaming BEI dapat menjadi optimasi fase berikutnya.

### 4.2 Metadata: kolom inti tervalidasi, metadata hanya untuk ekstensi

Tambahkan field inti sebagai kolom/schema resmi:

```text
ipo_hype_score
ipo_archetype
oversubscription_ratio
float_ratio
sector_sentiment
listing_sentiment
subscription_lot_size
version
published_at
```

Initial fair value tetap memakai modul `fair_values` resmi dan direferensikan
dari response IPO. Jangan membuat source of truth fair value kedua di JSON
metadata.

### 4.3 Waktu: timestamp adalah authority, session ID sebagai konteks

Lifecycle finansial menggunakan `subscription_start`, `subscription_end`, dan
`listing_at` bertipe timestamp/date. Session ID boleh dikirim sebagai informasi
simulasi, tetapi tidak menggantikan window waktu authoritative.

### 4.4 Satu active subscription per account per IPO

Gunakan unique constraint logis `(ipo_event_id, broker_account_id)` untuk
subscription non-final. Perubahan jumlah dilakukan melalui cancel lalu
subscription baru atau endpoint amend di fase berikutnya.

### 4.5 Dynamic market-data universe

BEI active securities menjadi authority. Saat set symbol berubah, MATS client
melakukan controlled reconnect dengan daftar simbol baru, mempertahankan
`MarketState` simbol lama, dan menandai simbol baru belum tradable sampai
snapshot/reference data tersedia.

### 4.6 Tidak menambah dependency baru

Fase ini dapat memakai HTTP client, scheduler, locking, retry, dan random source
yang sudah ada. Library/outbox baru hanya dipertimbangkan bila BEI belum
memiliki primitive persistence yang memadai; default plan memakai tabel outbox
PostgreSQL sederhana dan worker internal.

## 5. Kontrak IPO Publik yang Ditargetkan

`GET /bot/ipo-lifecycle` mengembalikan hanya event publik dan field eksplisit:

```json
{
  "items": [
    {
      "id": "uuid",
      "version": 3,
      "issuer_code": "NEWC",
      "symbol": "NEWC",
      "company_name": "New Company Tbk",
      "status": "subscription",
      "offered_shares": 10000000,
      "offering_price_idr": 200,
      "subscription_lot_size": 100,
      "subscription_start": "2026-07-04T01:00:00Z",
      "subscription_end": "2026-07-04T03:00:00Z",
      "listing_at": "2026-07-05T01:00:00Z",
      "ipo_hype_score": 88,
      "ipo_archetype": "hot_ipo",
      "oversubscription_ratio": 15.2,
      "float_ratio": "low",
      "sector_sentiment": "positive",
      "listing_sentiment": "high",
      "fair_value_initial": 260,
      "fair_value_confidence": "low",
      "published_at": "2026-07-04T00:30:00Z",
      "updated_at": "2026-07-04T00:45:00Z"
    }
  ],
  "as_of": "2026-07-04T00:45:01Z"
}
```

Rules:

1. `draft` dan unpublished event tidak diberikan kepada BOT/player.
2. Integer rupiah dan shares harus aman dipetakan ke `int64`.
3. Unknown enum ditolak saat create/update, bukan diteruskan diam-diam.
4. `version` naik pada perubahan material.
5. Response player dan BOT berasal dari projection/domain yang sama.
6. Cancelled/listed event tetap tersedia selama retention window agar client
   dapat melihat transisi final.

## 6. Pembagian Implementasi

Fase 5 dibagi menjadi tujuh subfase. Setiap subfase harus lulus test dan exit
criteria sebelum lanjut.

## 6.1 Subfase 5A - Freeze Kontrak dan Hardening BEI

Tujuan: membuat IPO publik dapat ditemukan secara lengkap dan lifecycle BEI
valid sebelum BOT melakukan mutation.

Task:

1. Tambahkan migration field inti IPO, enum/check constraint, default, index
   status/window, dan version.
2. Pisahkan create security calon listing dari status `listed`; gunakan status
   non-tradable sampai transition listing.
3. Buat DTO/projection publik IPO yang dipakai endpoint BOT dan player.
4. Ubah `/bot/ipo-lifecycle` agar:
   - menggunakan left join yang aman;
   - membawa event ID dan seluruh field kontrak;
   - mengecualikan draft/unpublished;
   - memakai wrapper `items` dan `as_of`;
   - menyortir secara stabil.
5. Tambahkan admin create/update/publish IPO dengan validasi:
   - window berurutan;
   - score 0-100;
   - archetype valid;
   - positive price/shares;
   - lot size positif;
   - symbol/issuer/security konsisten.
6. Perketat endpoint subscription BEI untuk status `subscription`, current
   window, lot multiple, idempotency conflict, dan duplicate account.
7. Perketat allocation:
   - hanya dari status subscription/allocation yang valid;
   - hasil kelipatan subscription lot;
   - total allocation tidak melebihi offered shares;
   - zero/partial/full allocation eksplisit;
   - transition dan ledger idempotent.
8. Pada listing transaction:
   - ubah IPO menjadi `listed`;
   - ubah security menjadi `listed/active`;
   - set IPO/reference price;
   - aktifkan initial fair value sesuai effective time;
   - tulis reliable outbox event.
9. Tambahkan outbox/retry untuk allocation, listing, cancel, dan reversal.
10. Dokumentasikan kontrak OpenAPI dan update endpoint readiness.

Test minimum:

1. Draft tidak terlihat; published terlihat.
2. Event tanpa listed security tetap dapat ditemukan.
3. Invalid window/score/archetype/lot ditolak.
4. Subscription sebelum/sesudah window ditolak.
5. Requested shares bukan kelipatan lot ditolak.
6. Partial dan zero allocation tetap menghasilkan state final.
7. Total allocation tidak melebihi supply.
8. Duplicate allocate/list/cancel tidak menggandakan ledger.
9. Listing mengaktifkan security, reference price, fair value, dan outbox secara
   konsisten.

Exit criteria:

- [x] Kontrak IPO publik stabil dan versioned.
- [x] Lifecycle BEI valid dari draft sampai listed/cancelled.
- [x] Listing membuat security tradable secara authoritative.
- [x] Webhook lifecycle tidak hilang permanen saat Sekuritas sementara gagal.

## 6.2 Subfase 5B - Hardening Accounting dan Reconciliation Sekuritas

Tujuan: menjamin subscription finansial aman sebelum diotomasi oleh banyak BOT.

Task:

1. Satukan logic endpoint IPO player dan BOT ke service domain yang sama.
2. Pastikan semua mutation mewajibkan idempotency key dan memvalidasi account
   ownership serta payload hash.
3. Tambahkan endpoint BOT:
   - lookup subscription by idempotency/client key;
   - list subscription aktif/history per account;
   - optional bulk snapshot subscription untuk startup BOT.
4. Tambahkan retry worker untuk state `cash_reserved` yang belum berhasil
   diteruskan ke BEI.
5. Definisikan terminal state:
   `cancelled`, `allocated`, `refunded`, `settled`, dan `reversed`.
6. Proses webhook memakai inbox/event ID unik dan state transition guard.
7. Pastikan zero allocation me-refund seluruh reserve dan mengirim account event.
8. Pastikan partial allocation mendebit aktual dan me-refund selisih.
9. Pastikan allocation mencatat position `pending`; listing saja yang membuat
   `available`.
10. Tambahkan subscription IPO ke portfolio/bulk recovery snapshot atau endpoint
    recovery khusus.
11. Perkaya `ipo_subscription_updated` dengan:
    `ipo_event_id`, `subscription_id`, `symbol`, `status`,
    `requested_shares`, `allocated_shares`, `reserved_cash_idr`,
    `actual_debit_idr`, dan `listed`.
12. Tambahkan invariant database/service untuk mencegah cash, reserved cash,
    pending shares, dan available shares negatif.

Test minimum:

1. Concurrent subscribe dengan saldo yang sama tidak membuat cash negatif.
2. Duplicate request mengembalikan subscription yang sama.
3. Timeout setelah reserve dapat direconcile tanpa reserve kedua.
4. Duplicate/out-of-order webhook tidak menggandakan debit/position/refund.
5. Zero, partial, dan full allocation benar.
6. Cancel sebelum allocation refund penuh.
7. Cancel setelah allocation mengikuti reversal.
8. Sell pre-listing ditolak karena available shares nol.
9. Restart dapat merekonstruksi state subscription.

Exit criteria:

- [x] Seluruh accounting IPO idempotent dan recoverable.
- [x] Tidak ada cash/position negatif pada concurrency test.
- [x] Player dan BOT menggunakan domain rule yang sama.
- [x] Account event cukup untuk cache BOT dan snapshot cukup untuk recovery.

## 6.3 Subfase 5C - Discovery dan Subscription Orchestrator BOT

Tujuan: BOT menemukan IPO, membuat keputusan subscription, dan pulih dari
timeout/restart.

Task:

1. Perluas model BEI `IPOLifecycle` sesuai kontrak final.
2. Tambahkan poll interval IPO 10-15 detik yang independen dari full reference
   poll, tetapi tetap satu scheduler global.
3. Buat `IPORegistry` thread-safe dengan:
   - latest version per event;
   - transition history ringkas;
   - discovered/processed marker;
   - subscription state per bot;
   - listing attention expiry.
4. Buat diff processor untuk event baru, version berubah, listed, dan cancelled.
5. Perbaiki Sekuritas client:
   - menerima idempotency key stabil;
   - mengembalikan response terstruktur;
   - lookup/reconcile saat response unknown;
   - classify retryable dan terminal error.
6. Buat `IPOSubscriptionPlanner`, bukan memasukkan subscription ke regular order
   queue.
7. Eligibility awal hanya strategy `event_driven` dengan status active dan
   subscription belum pernah final.
8. Sizing menggunakan:
   - available cash resmi;
   - max cash exposure per IPO;
   - lot size subscription;
   - hype/archetype/fair-value confidence;
   - diversification dan random personality factor.
9. Default risk limit yang direkomendasikan:
   - maksimal 5-20% available cash per IPO per bot;
   - maksimal satu active subscription per IPO;
   - tidak memakai reserved cash;
   - tidak subscribe pada `overpriced_ipo` jika offering price terlalu jauh di
     atas fair value, kecuali personality agresif;
   - deterministic RNG saat test.
10. Gunakan idempotency key stabil:
    `bot:ipo:<external_bot_id>:<ipo_event_id>:v<decision_version>`.
11. Consume `ipo_subscription_updated` dan update registry/cache.
12. Pada startup, reconcile registry dari subscription snapshot/lookup sebelum
    membuat keputusan baru.
13. Tambahkan log/metric discovery, eligible, attempted, accepted, allocated,
    refunded, listed, dan failed.

Test minimum:

1. IPO baru ditemukan sekali walau dipoll berulang.
2. Version update diproses tanpa membuat duplicate subscription.
3. Hanya event pada subscription window yang dipilih.
4. Requested shares selalu lot multiple dan sesuai cash limit.
5. Timeout melakukan lookup dengan key sama, bukan request baru.
6. Restart tidak membuat reserve/subscription kedua.
7. Cancelled IPO membersihkan pending decision.
8. Bot paused/bankrupt tidak subscribe.

Exit criteria:

- [x] IPO Hunter subscribe tanpa hardcode event/symbol.
- [x] Subscription tidak memakai regular order limit.
- [x] Unknown outcome selalu direconcile.
- [x] Restart tidak menggandakan subscription atau reserve.

## 6.4 Subfase 5D - Dynamic Listed Universe dan MATS Resubscription

Tujuan: symbol baru menjadi tradeable dan observable tanpa restart service.

Task:

1. Tambahkan fast active-security refresh saat IPO berubah menjadi `listed`.
2. Buat `UniverseManager` yang menghitung set diff listed symbols.
3. Jadikan config MATS `symbols` sebagai optional allowlist/bootstrap, bukan
   source of truth permanen.
4. Tambahkan method MATS client `UpdateSymbols`:
   - normalize/sort/deduplicate;
   - no-op bila set sama;
   - controlled reconnect bila berubah;
   - serialisasi reconnect agar tidak terjadi reconnect storm;
   - pertahankan cache simbol existing;
   - tunggu initial snapshot simbol baru.
5. Tandai simbol baru `warming_up` sampai security rules/reference price dan
   market-data minimum tersedia.
6. Strategy hanya boleh order simbol baru jika:
   - BEI status listed/active;
   - rule/reference price tersedia;
   - MATS signal/snapshot cukup atau fallback listing price diperbolehkan secara
     eksplisit untuk opening auction.
7. Verifikasi MATS menerima symbol setelah sinkronisasi BEI dan menolak sebelum
   listed.
8. Hapus hardcode MNDL/NUSA/BARA dari jalur runtime; pertahankan pada fixture
   test saja.

Test minimum:

1. Menambah listed symbol memicu satu controlled reconnect.
2. Poll berulang dengan set sama tidak reconnect.
3. Symbol lama tetap memiliki market state.
4. Symbol baru menerima snapshot/update.
5. Strategy tidak order saat warming up.
6. Delisted/suspended symbol dikeluarkan atau diblok sesuai status.

Exit criteria:

- [x] Listing terdeteksi dan masuk universe tanpa restart.
- [x] BOT menerima market data simbol baru.
- [x] Tidak ada order sebelum tradability readiness lengkap.

## 6.5 Subfase 5E - Public IPO Frontend

Tujuan: player dapat menemukan, memahami, mengikuti, dan memantau IPO memakai
data publik yang secara prinsip sama dengan data yang digunakan BOT.

Scope:

1. Frontend Sekuritas untuk player; bukan admin lifecycle BEI.
2. Read model IPO publik berasal dari kontrak backend, bukan hardcode atau
   akses langsung ke database BEI.
3. Subscription/cancel tetap melalui Sekuritas backend.
4. Frontend tidak menghitung allocation, hype, fair value, atau lifecycle
   secara authoritative.

Task:

1. Tambahkan client dan type frontend untuk:
   - list/detail IPO publik;
   - create subscription;
   - cancel subscription;
   - list/history subscription milik player.
2. Buat halaman/section daftar IPO dengan state:
   `bookbuilding`, `subscription`, `allocation`, `listed`, dan `cancelled`.
3. Tampilkan informasi minimum:
   - symbol dan company name;
   - offering price dan offered shares;
   - subscription lot size;
   - subscription/listing schedule;
   - status lifecycle;
   - public hype label/score representation;
   - archetype atau penjelasan publik yang setara;
   - initial fair value dan confidence;
   - sector/listing sentiment bila dipublikasikan.
4. Buat detail IPO dengan penjelasan bahwa hype dan fair value bukan jaminan
   return atau allocation.
5. Buat form subscription yang:
   - hanya aktif dalam subscription window;
   - menerima quantity dalam lot/share yang jelas;
   - memvalidasi lot multiple;
   - menampilkan estimasi reserve;
   - meminta konfirmasi sebelum submit;
   - mencegah double submit selama request berjalan.
6. Gunakan idempotency key stabil per submit attempt dan pertahankan sampai
   outcome diketahui.
7. Tampilkan status investor secara eksplisit:
   `cash_reserved`, `submitted_to_bei`, `allocated`, `refunded`, `settled`,
   `cancelled`, atau `reversed`.
8. Tampilkan requested shares, allocated shares, reserve, actual debit, dan
   refund tanpa menghitung ulang source of truth di browser.
9. Sediakan cancel action hanya ketika backend menyatakan subscription masih
   cancellable.
10. Sinkronkan perubahan lifecycle melalui polling ringan atau notification
    existing; fallback polling harus berhenti saat page tidak aktif.
11. Tangani loading, empty, stale, dependency unavailable, retryable error,
    idempotency conflict, insufficient balance, dan closed window.
12. Pastikan responsive layout, keyboard navigation, focus management, label
    form, error association, dan status announcement dapat diakses.
13. Jangan tampilkan draft, future unpublished metadata, allocation bot lain,
    atau informasi privat investor lain.

Test minimum:

1. Draft/unpublished IPO tidak muncul.
2. Status, schedule, price, lot, hype, dan fair value tampil sesuai response.
3. Form menolak zero, negative, dan non-lot-multiple quantity.
4. Double click tidak menghasilkan subscription kedua.
5. Timeout/retry mempertahankan idempotency key yang sama.
6. Cancel hanya tersedia untuk state yang diperbolehkan.
7. Zero/partial/full allocation dan refund ditampilkan benar.
8. Listing mengubah status dan mengarahkan player ke market detail symbol yang
   sudah aktif.
9. Loading, empty, error, dan stale state dapat dibedakan.
10. Tampilan desktop/mobile dan alur keyboard utama lulus.
11. Kontrak data publik frontend tidak lebih lengkap atau lebih rahasia daripada
    kontrak yang diperbolehkan untuk BOT.

Exit criteria:

- [ ] Player dapat menemukan IPO publik dan membuka detailnya.
- [ ] Player dapat subscribe/cancel melalui Sekuritas secara idempotent.
- [ ] Player dapat melihat lifecycle subscription dan hasil allocation.
- [ ] Hype serta fair value diberi konteks dan tidak ditampilkan sebagai jaminan.
- [ ] Data privat dan draft tidak terekspos.
- [ ] Responsive, accessibility, dan error-state test lulus.

## 6.6 Subfase 5F - IPO Behavior dan Price Discovery

Tujuan: IPO menghasilkan variasi perilaku yang terasa tetapi tetap berasal dari
order dan data publik.

Task:

1. Pisahkan dua perilaku Event-Driven:
   - pre-listing `IPO Hunter` untuk subscription;
   - post-listing first responder untuk attention/listing sentiment.
2. Tambahkan `IPOContext` ke input strategi tanpa mengubah MATS.
3. Buat attention boost dengan decay berbasis session:
   - tinggi pada listing session;
   - menurun selama 3-10 session;
   - dapat berakhir lebih cepat jika volume rendah.
4. Respons awal per strategy:
   - Event-Driven: respons hype/sentiment paling cepat;
   - Noise: probabilitas FOMO terbatas;
   - Momentum: wajib price/volume confirmation;
   - Market Maker: spread lebih lebar, size lebih kecil, dapat withdraw;
   - Value: memakai initial fair value dengan confidence discount;
   - Contrarian: menunggu pullback/deviation;
   - Bandar: probabilistik dan dibatasi inventory/risk;
   - Index Tracker: tidak bereaksi kecuali membership berubah.
5. Map archetype ke bias, bukan hasil harga:

| Archetype | Bias awal |
|---|---|
| `hot_ipo` | attention tinggi, bullish probability tinggi, volatility tinggi |
| `normal_ipo` | attention sedang, dua arah |
| `overpriced_ipo` | minat awal mungkin tinggi, value demand rendah, reversal risk |
| `quiet_ipo` | participation dan size rendah |
| `failed_hype_ipo` | attention awal ada, buy follow-through lemah, sell risk naik |

6. Tambahkan random factor per IPO/run agar hype sama tidak menghasilkan jalur
   harga identik.
7. Terapkan fair-value brakes dan ARA/ARB awareness yang sudah ada.
8. Batasi total participation IPO lintas bot dan order burst per symbol.
9. Pastikan allocation tidak otomatis menyebabkan sell; keputusan sell hanya
   setelah listed dan sesuai strategi.
10. Simpan memory ringkas: subscribed, allocation, listing session, peak return,
    consecutive ARA/ARB, dan attention expiry.

Test minimum:

1. Event-Driven lebih responsif daripada secondary responder.
2. Momentum tidak masuk tanpa confirmation.
3. Value mengurangi demand pada overpriced IPO.
4. Market Maker widen/withdraw pada volatility tinggi.
5. Attention decay mengurangi participation lintas session.
6. Seed berbeda menghasilkan jalur keputusan berbeda; fixed seed reproducible.
7. Tidak ada strategy yang bypass cash/position/session/rules.

Exit criteria:

- [ ] Hype memengaruhi keputusan, bukan mengubah harga langsung.
- [ ] IPO hot dapat naik kuat tetapi tidak selalu ARA.
- [ ] IPO normal/quiet/failed hype menunjukkan pola yang berbeda secara statistik.

## 6.7 Subfase 5G - E2E, Realism, Observability, dan Dokumentasi

Tujuan: membuktikan flow lintas layanan dan kualitas simulasi.

Skenario E2E wajib:

1. Hot IPO, oversubscribed, partial allocation, listing, pergerakan kuat.
2. Normal IPO, full/partial allocation, price discovery dua arah.
3. Quiet IPO dengan volume rendah.
4. Overpriced IPO yang gagal mempertahankan kenaikan.
5. Failed hype IPO yang dapat turun.
6. Zero allocation dan full refund.
7. Cancel sebelum allocation.
8. BEI timeout saat subscribe lalu reconcile.
9. Sekuritas unavailable saat webhook lalu outbox retry.
10. BOT restart setelah reserve, setelah allocation, dan setelah listing.
11. Duplicate allocate/list/webhook.
12. Listing symbol baru saat BOT sedang hidup.

Invariant:

```text
cash_available >= 0
cash_reserved >= 0
position_available >= 0
position_pending >= 0
allocated_shares <= requested_shares
sum(allocation) <= offered_shares
actual_debit = allocated_shares * offering_price + official_fee
reserved_release = original_reserve - actual_debit
pre-listing allocated shares tidak sellable
duplicate event tidak mengubah saldo/position dua kali
```

Metric minimum:

1. IPO discovered by status/archetype.
2. Subscription eligible/attempted/accepted/rejected.
3. Reserved, allocated, refunded, and settled value.
4. Allocation ratio per IPO.
5. Reconcile/retry count dan oldest pending age.
6. Listing-to-universe latency.
7. MATS resubscribe count/failure.
8. Order count/volume/return/ARA/ARB per IPO session.
9. Participation dan PnL per strategy.

Realism test:

1. Jalankan minimal 30 simulation seeds per archetype.
2. Bandingkan median return, dispersion, volume, spread, dan ARA frequency.
3. Jangan menetapkan target “hot selalu naik”; gunakan rentang probabilistik.
4. Rekomendasi baseline awal:
   - hot IPO lebih sering menghasilkan positive first-session return daripada
     normal IPO;
   - normal IPO tidak dominan ARA;
   - quiet IPO memiliki median volume lebih rendah;
   - overpriced/failed hype memiliki reversal/downside frequency lebih tinggi;
   - tidak ada archetype dengan ARA rate 100%.
5. Threshold final dikalibrasi dari hasil test, bukan dikunci sebelum data ada.

Dokumentasi:

1. Update `BOT_V2_READY_ENDPOINTS.md`.
2. Update OpenAPI BEI dan Sekuritas.
3. Tambahkan runbook create-publish-allocate-list-cancel IPO.
4. Tambahkan contoh Postman/curl untuk player dan BOT.
5. Catat hasil statistical realism dan parameter final.

Exit criteria:

- [ ] Seluruh skenario E2E dan invariant lulus.
- [ ] Listing-to-universe berjalan tanpa restart.
- [ ] Tidak ada silent lifecycle event loss.
- [ ] Hasil multi-seed membedakan archetype tanpa pola deterministik.
- [ ] Dokumentasi kontrak dan operasional sinkron dengan kode.

## 7. Urutan Eksekusi dan Dependency

```text
5A BEI contract/lifecycle
  -> 5B Sekuritas accounting/recovery
    -> 5C BOT discovery/subscription
      -> 5D dynamic universe/MATS
        -> 5E public IPO frontend
          -> 5F behavior/realism
            -> 5G E2E and calibration
```

5A dan 5B tidak boleh dilewati karena automation BOT akan memperbesar dampak
bug accounting. Frontend 5E dimulai setelah kontrak BEI dan Sekuritas stabil.
Behavior 5F tidak dimulai sebelum dynamic universe 5D stabil. Validasi akhir 5G
baru dilakukan setelah frontend dan behavior selesai.

## 8. File/Area yang Diperkirakan Berubah

### BEI

1. `BEI/src/db/schema.ts` dan migration baru.
2. `BEI/src/routes/corporate-actions.ts`.
3. `BEI/src/routes/bot.ts`.
4. `BEI/src/routes/fair-values.ts`.
5. Service outbox/webhook dan contract tests.
6. OpenAPI/admin API documentation.

### Sekuritas

1. `SEKURITAS/backend/src/db/schema.ts` dan migration baru.
2. `routes/bot.ts` dan `routes/ipo-subscriptions.ts`.
3. `services/ipo-lifecycle-service.ts`.
4. `services/bot-event-service.ts`.
5. Service IPO domain/reconciliation worker baru.
6. Integration/E2E scripts dan frontend IPO projection.

### Frontend Sekuritas

1. `SEKURITAS/frontend/src/api/client.ts`.
2. Type API frontend.
3. Routing/navigation dashboard.
4. Halaman daftar dan detail IPO.
5. Komponen subscription, status allocation, error, dan empty state.
6. Responsive, accessibility, dan component/integration tests.

### BOT

1. `internal/client/bei/bei.go`.
2. `internal/client/sekuritas/sekuritas.go`.
3. `internal/client/mats/mats.go`.
4. `internal/scheduler/`.
5. Package baru `internal/ipo/` untuk registry, discovery, planner, dan executor.
6. `internal/registry/` dan account event handler.
7. Seluruh strategy yang menerima IPO context.
8. Config, metrics, tests, dan `cmd/bot/main.go`.

### MATS

Perubahan diperkirakan minimal dan hanya dilakukan bila sinkronisasi security
baru atau WebSocket filter terbukti belum mendukung flow listing.

## 9. Risiko dan Mitigasi

| Risiko | Mitigasi |
|---|---|
| Duplicate reserve/debit/allocation | Stable idempotency key, inbox/outbox, lookup/reconcile |
| Event listing hilang | Persistent BEI outbox dan retry |
| Saham dijual sebelum listed | Pending vs available invariant di Sekuritas |
| BOT tidak melihat symbol baru | Active-security diff dan controlled MATS reconnect |
| Reconnect storm | Set equality, debounce, single reconnect lock |
| Semua hot IPO ARA | Probabilistic response, fair-value brake, participant cap, multi-seed calibration |
| Hype menjadi informasi rahasia BOT | Projection publik yang sama untuk player dan BOT |
| Hardcode tiga symbol tetap bocor | BEI listed securities sebagai runtime authority |
| Subscription mengganggu order limiter | Queue/planner IPO terpisah dengan risk/rate limit sendiri |
| Metadata JSON tidak konsisten | Typed columns/DTO dan validation |
| Scope membesar ke redesign MATS | MATS tetap matching-only; perubahan hanya tradability/symbol subscription |

## 10. Definition of Done Fase 5

- [ ] Admin dapat create, publish, allocate, list, dan cancel IPO tervalidasi.
- [ ] BOT menemukan IPO publik baru tanpa hardcode dan tanpa restart.
- [ ] Event-Driven/IPO Hunter subscribe lewat Sekuritas secara idempotent.
- [ ] Unknown outcome dan restart dapat direconcile.
- [ ] Zero/partial/full allocation serta refund benar.
- [ ] Cash dan position tidak pernah negatif.
- [ ] Saham allocation tetap pending dan tidak dapat dijual sebelum listed.
- [ ] Listing mengaktifkan security, reference price, dan initial fair value.
- [ ] Simbol listed masuk universe serta market-data BOT secara dinamis.
- [ ] Seluruh order pasca-listing tetap melalui Sekuritas ke MATS.
- [ ] Player dapat melihat IPO publik serta subscribe/cancel melalui Sekuritas.
- [ ] Player dapat memantau reserve, allocation, refund, dan listing.
- [ ] Frontend tidak mengekspos draft atau data privat investor lain.
- [ ] IPO attention boost berlaku ke beberapa strategy dengan decay.
- [ ] Hype/archetype menghasilkan variasi statistik, bukan outcome pasti.
- [ ] Hot IPO dapat bergerak kuat dan normal IPO tidak selalu ARA.
- [ ] Player melihat metadata publik yang secara prinsip sama dengan BOT.
- [ ] Duplicate/out-of-order event tidak menggandakan mutation.
- [ ] Contract, integration, E2E, concurrency, restart, dan realism tests lulus.

## 11. Keputusan yang Perlu Dikonfirmasi Sebelum Eksekusi

Plan dapat dieksekusi dengan default rekomendasi berikut:

1. Discovery memakai polling 10-15 detik, bukan event bus.
2. Field IPO inti menjadi kolom tervalidasi; fair value tetap di modul fair value.
3. Satu active subscription per bot per IPO.
4. Maksimal exposure subscription 5-20% available cash berdasarkan personality.
5. IPO listing dapat dilakukan intraday, tetapi BOT menunggu tradability readiness
   sebelum order.
6. Config MATS symbol menjadi optional allowlist/bootstrap; BEI tetap authority.
7. BEI memakai persistent outbox PostgreSQL untuk webhook lifecycle.
8. Statistical realism memakai minimal 30 seed per archetype sebelum tuning final.

Jika salah satu default tersebut tidak sesuai arah produk, keputusan itu sebaiknya
diubah sebelum Subfase 5A agar kontrak tidak direvisi di tengah implementasi.

## 12. Environment Development dan Production

Implementasi Fase 5 wajib dijalankan melalui environment eksplisit:

1. Local development menggunakan `.env.development`.
2. Production menggunakan `.env.production` atau environment variables dari
   deployment platform dengan kontrak yang sama.
3. `.env` generik bukan source of truth untuk runtime Fase 5.
4. `start-all.bat development` dan `start-all.bat production` memasang
   `DOTENV_CONFIG_PATH=.env.<environment>` untuk service Node.js.
5. Migration dan seed manual wajib dijalankan dengan `DOTENV_CONFIG_PATH`
   yang menunjuk environment target.

Scope BEI minimum:

| Service | Scope IPO minimum |
|---|---|
| Sekuritas | `ipo:read`, `ipo:write`, `custody:read`, `custody:write`, `corporate-action:read` |
| BOT | `market:read`, `rules:read`, `ipo:read` |
| MATS | Tidak membutuhkan scope IPO; tetap membutuhkan market/rules/session scope |

Production juga wajib menyediakan:

1. Token kuat dan unik, minimal 32 karakter.
2. `BEI_TO_SEKURITAS_TOKEN`.
3. `SEKURITAS_CORPORATE_ACTION_WEBHOOK_URL`.
4. `SEKURITAS_SETTLEMENT_WEBHOOK_URL`.
5. Database dan Redis production, bukan endpoint development.

BEI melakukan fail-fast saat service identity atau scope minimum tidak lengkap.
Nilai secret tidak boleh disalin dari development ke production.

Credential internal BEI, MATS, Sekuritas, dan BOT dapat dirotasi serta
disinkronkan tanpa mencetak nilainya melalui:

```powershell
.\scripts\rotate-production-service-tokens.ps1
```

Script tersebut tidak membuat `BANK_MANDALA_API_KEY` atau menentukan
`BANK_MANDALA_URL`; keduanya harus diterbitkan oleh deployment Bank Mandala.
