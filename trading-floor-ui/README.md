# Trading Floor UI

Kantor virtual isometrik untuk tim agent `trading-floor-engine`. Port Next.js dari `prototype/trading-floor.html`,
membaca data asli dari `../trading-floor-engine/office`.

```powershell
cd C:\Users\user\trading\trading-floor-ui
npm install
npm run dev        # http://localhost:3000
```

Opsional: salin `.env.local.example` ke `.env.local` kalau lokasi `office/` berbeda.

## Yang dibaca dari office/

| Tampilan | Sumber |
|---|---|
| Bubble & state agent | `agents/<slug>/status.json`, kalau tidak ada disimpulkan dari inbox, scan, debat, log bot |
| Panel agent | `CATATAN-<NAMA>.md` + pesan inbox dari/ke agent itu |
| Amplop terbang | file baru di `inbox/<agent>/` (lewat SSE) |
| Ruang Meeting | debat di `debates/` yang umurnya < 10 menit |
| Papan Riset & Jurnal | tabel peringkat `backtests/scan-*.md` terbaru yang bukan data sintetis (file `.json` 40MB tidak pernah dibaca) |
| Execution Room | mode bot dari log `Bot dimulai. Mode: …`, posisi dari `execution/state.json`, lampu merah kalau ada posisi |
| Risk Desk | exposure, penolakan hari ini dari log, kill switch |
| Ruang Bos | `approvals/*.json` (skema dari `src/exec/approvals.ts`), `RISK-RULES.md` |
| Ticker | Binance Futures publik `ticker/24hr` → fallback `market/snapshot.json` → close terakhir di `data/<SYMBOL>_4h.json` |

## Yang ditulis UI (hanya ini)

- `approvals/<id>.json`: field `status`, `catatanBos`, `decidedAt` saja, hanya kalau status masih `pending`
- `execution/STOP`: tombol kill switch dengan konfirmasi di halaman. Tidak ada tombol untuk menghapusnya.

Semua tulisan atomik (`.tmp` lalu rename) dan path dicek tetap di dalam `OFFICE_DIR`.
UI tidak pernah mengirim order, tidak membaca `.env` engine, dan tidak mengubah `EXEC_MODE` atau watchlist.

## Kode

- `src/lib/office/`: semua akses filesystem (server saja), skema zod di `schemas.ts`, tulis di `writes.ts`
- `src/app/api/office/*`: `snapshot`, `events` (SSE, chokidar), `approvals/[id]`, `kill-switch`, `agents/[slug]`, `reports/[name]`
- `src/components/floor/scene.ts`: renderer Canvas 2D dari prototipe (iso, depth sort, BFS antar pintu, mode malam WIB)
- `src/components/floor/TradingFloor.tsx`: halaman utama; `Panel.tsx`: isi panel per ruang / agent
- Mode demo hanya visual di browser, otomatis nyala kalau `office/` kosong
