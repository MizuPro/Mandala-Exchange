# BEI-like Rules & Feature Audit

Dokumen ini merangkum hasil verifikasi aturan/fungsi BEI-like yang perlu dipertimbangkan untuk Mandala Exchange. Tujuannya bukan menyalin seluruh BEI secara 1:1, tetapi memastikan fitur inti bursa saham simulasi tidak kehilangan konsep penting.

## 1. Sudah Masuk Scope PRD/Plan
- Market authority: data emiten, saham tercatat, papan pencatatan, status listed/suspended/delisted, special notation/watchlist.
- Broker member registry: MVP memakai Mandala Sekuritas, tetapi schema disiapkan untuk multi-broker.
- Market segment: regular market sebagai MVP, cash market dan negotiated market disiapkan secara schema/rule-ready.
- Session template: pre-opening, opening auction, continuous market, pre-closing, random closing, non-cancellation period, closing auction, post-closing optional, closed, halted.
- Auction data: IEP dan IEV pada opening/closing auction.
- Order book rule: price-time priority, full depth order book, partial fill, amend, cancel, expire.
- Order validity: order yang belum matched expired otomatis pada akhir sesi.
- Non-cancellation period: order tertentu tidak bisa amend/cancel pada periode pre-opening/pre-closing yang dikunci.
- Lot size: preset saham 1 lot = 100 lembar, configurable.
- Fraksi harga/tick size: rule per rentang harga, configurable.
- Reference price: previous close, IPO/listing price, opening price, dan corporate action adjusted price.
- Price band: ARA/ARB berbasis reference price, board, dan rentang harga; bukan satu persentase flat.
- Auto rejection: harga di luar price band, tick tidak valid, volume terlalu besar, symbol suspend/halt, market closed.
- ARA/ARB: preset BEI-like dengan ARA bertingkat dan ARB default 15% untuk papan umum; configurable.
- Trading halt/circuit breaker: market-wide halt berbasis market index dan manual halt/resume.
- Symbol suspend/resume: manual maupun berdasarkan special notation/status.
- Market data: last price, best bid/ask, full depth, trade tape, IEP/IEV, market summary.
- Market summary/index: OHLC, volume, value, frequency, top gainers/losers, most active, market index/sector index sederhana.
- Trade capture: MATS mengirim trade resmi ke BEI secara idempotent.
- Clearing: MVP sederhana per investor/per trade, dengan rencana netting broker/session.
- Settlement: configurable, default end-of-session; settlement failure tidak disimulasikan pada MVP.
- Settlement instruction: DVP/RVP/FOP secara konseptual.
- Custody ledger: append-only position/cash movement, custody account, SID/SRE/RDN simulation reference.
- Corporate action: IPO, dividen, stock split, reverse split, bonus share, rights issue/HMETD, warrant.
- Company analysis: profil perusahaan, laporan keuangan manual, generator laporan keuangan, rasio dasar.
- Issuer announcement: pengumuman emiten, berita material, jadwal RUPS/dividen/IPO/corporate action.
- Fee/tax schedule: broker commission, levy/bursa, clearing, settlement, guarantee fund optional, PPN, PPh final jual.
- Surveillance dasar: price/volume anomaly, ARA/ARB beruntun, wash-trade sederhana, cancellation rate tinggi, dominasi order bot.

## 2. Sengaja Tidak Masuk MVP Penuh
- Full periodic call auction untuk Papan Pemantauan Khusus: schema/rule-ready dulu, implement penuh setelah regular market stabil.
- Margin trading dan short selling: dilarang di MVP, disiapkan sebagai fitur masa depan.
- Securities lending/borrowing: belum masuk MVP.
- Pasar tunai dan pasar negosiasi operasional penuh: schema/rule-ready, regular market dulu.
- Settlement failure/default waterfall: tidak disimulasikan dulu.
- Integrasi bank/RDN sungguhan, AKSes KSEI, IDXNet asli, dan pelaporan OJK asli: tidak dibutuhkan untuk simulasi privat.
- Produk non-saham seperti obligasi, ETF, DIRE, DINFRA, waran terstruktur, derivatif, dan carbon market: di luar scope saham MVP.
- Disaster recovery, data center, certification, dan regulasi operasional institusional: tidak masuk MVP.

## 3. Rekomendasi Prioritas
- Prioritas 1: regular market yang kuat, order book deterministik, price-time priority, ARA/ARB, fraksi harga, full depth, settlement, dan portfolio ledger.
- Prioritas 2: opening/closing auction, IEP/IEV, non-cancellation period, market summary, corporate action, dan company analysis.
- Prioritas 3: surveillance, index/sector index, special notation/watchlist, generator fundamental, dan bot strategy yang lebih kaya.
- Prioritas 4: full periodic call auction, pasar tunai/negosiasi, margin/short selling, dan settlement failure simulation.

## 4. Sumber Verifikasi Utama
- BEI, Jam dan Mekanisme Perdagangan: https://www.idx.co.id/id/produk-layanan/jam-dan-mekanisme-perdagangan/
- BEI, ARB 15% dan trading halt 2025: https://www.idx.co.id/id/berita/siaran-pers/2352
- BEI, Non-Cancellation Period: https://www.idx.co.id/id/berita/siaran-pers/2521
- BEI, Saham dan papan pencatatan: https://www.idx.co.id/id/produk/saham
- KSEI, Jasa Penyelesaian Transaksi: https://web.ksei.co.id/services/types/transaction-settlement
- KSEI, Jasa Kustodian Sentral: https://web.ksei.co.id/services/types/central-security-depository
- KPEI, Kliring Produk Ekuitas: https://www.idclear.co.id/id/segmentasi/ekuitas/kliring
- KPEI, Biaya Kliring Ekuitas: https://www.idclear.co.id/id/segmentasi/ekuitas/biaya
- BEI, Perpajakan saham: https://www.idx.co.id/id/investhub/perpajakan/
