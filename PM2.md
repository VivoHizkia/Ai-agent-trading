# Menjalankan Trading Floor dengan pm2

pm2 menjaga 3 proses tetap hidup dan menghidupkannya lagi kalau crash:

| Nama | Isi |
|---|---|
| `tf-bot` | `trading-floor-engine` → bot eksekusi (`src/exec/bot.ts`) |
| `tf-notify` | `trading-floor-engine` → notifier + layanan kantor (Telegram, berita, regime, review, lab) |
| `tf-dashboard` | `trading-floor-ui` → dashboard di http://localhost:3000 |

## Setup sekali

```powershell
# 1. Tutup dulu semua terminal "npm run bot", "npm run notify", "npm run dev" yang masih jalan.
#    PENTING: jangan sampai ada 2 bot jalan bersamaan (akan dobel order).

npm install -g pm2

cd C:\Users\user\trading\trading-floor-ui
npm run build                      # dashboard versi produksi (ulangi setiap ada update dashboard)

cd C:\Users\user\trading
pm2 start ecosystem.config.cjs
pm2 save                           # simpan daftar proses untuk dihidupkan lagi setelah restart PC
```

## Hidup otomatis setelah PC restart

1. Tekan `Win + R`, ketik `shell:startup`, Enter.
2. Buat shortcut ke `C:\Users\user\trading\trading-floor-start.bat` di folder itu.

Proses hidup lagi begitu kamu login Windows.

## Perintah sehari-hari

```powershell
pm2 status                 # lihat semua proses
pm2 logs tf-bot            # log bot (Ctrl+C untuk keluar)
pm2 restart tf-bot         # restart bot (mis. setelah ubah .env)
pm2 restart tf-dashboard   # setelah "npm run build" dashboard baru
pm2 stop all               # hentikan semua
```

## Kill switch

Kalau kill switch aktif (`office/execution/STOP`), bot berhenti normal dan pm2 **tidak** menghidupkannya lagi.
Di `pm2 status` bot akan tampil `waiting restart` dengan jumlah restart yang tidak bertambah; itu normal.
Untuk jalan lagi: hapus file `STOP`, lalu `pm2 restart tf-bot`.

## Jangan sampai PC tidur

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
```
(Saat laptop dicolok charger. Layar boleh tetap mati.)
