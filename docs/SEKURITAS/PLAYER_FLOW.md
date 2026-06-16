# Player Flow - Mandala Sekuritas

## 1. Registrasi & Verifikasi
1. Player melakukan registrasi dengan email dan password.
2. Akun dibuat dengan status `unverified`. Sebuah record `broker_account` dibuat secara otomatis (jika BOT, otomatis terverifikasi dan flag BOT aktif).
3. Player menerima email verifikasi berisi OTP / Link.
4. Player melakukan verifikasi email. Status akun menjadi `verified`.

## 2. Login & Inisialisasi
1. Player login menggunakan email dan password.
2. Sistem mengembalikan JWT token.
3. Frontend mengambil data `broker_account` beserta SID/SRE/RDN simulation reference.
4. Frontend mengambil `cash_balance` dan `securities_position` (portfolio) terkini.

## 3. Market Data & Analisis
1. Frontend melakukan koneksi WebSocket langsung ke MATS untuk menerima market data publik (Order Book, Trade Tape, Last Price, dll).
2. Frontend mengambil data profil emiten, special notation, dan laporan keuangan dari API backend Sekuritas (yang mem-proxy/cache dari BEI).

## 4. Deposit Awal
1. Admin (melalui panel admin) melakukan seed/deposit awal ke `cash_balance` akun player.
2. Saldo `available_cash` bertambah.

## 5. Order Entry & Reservation
1. Player memasukkan Buy Order.
2. Frontend memanggil API Create Order di backend Sekuritas.
3. Backend validasi: apakah `available_cash` >= `(price * qty * lot_size) + fee_estimate`?
4. Jika ya, pindahkan dana dari `available_cash` ke `reserved_cash`.
5. Backend mengirim request Place Order ke API MATS.
6. Jika MATS accept, status order menjadi `ACCEPTED`. Jika reject, status `REJECTED` dan `reserved_cash` dikembalikan ke `available_cash`.

## 6. Order Matching & Settlement
1. MATS mengirimkan trade update (webhook/API) ke Sekuritas bahwa order telah filled (parsial/full).
2. Backend sekuritas memindahkan `reserved_cash` / `reserved_shares` menjadi `pending_cash` / `pending_shares`.
3. Di akhir sesi, BEI mengirim notifikasi Settlement Completed.
4. Backend mengubah status `pending` menjadi posisi aktual (`available`). Fee direalisasikan dan dipotong.

## 7. Leaderboard
1. Player dapat melihat ranking berdasarkan net asset value (NAV), return %, dan realized P/L melalui menu Leaderboard.
