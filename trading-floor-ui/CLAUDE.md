# Trading Floor UI

Kantor virtual isometrik (gaya game cozy) yang memvisualisasikan tim agent trading futures milik Vivo.
Setiap "karyawan" mewakili satu bagian dari `trading-floor-engine`. Status, pesan, hasil scan, debat,
dan log bot dibaca dari folder `office/` engine, lalu ditampilkan secara real-time.

Bahasa UI: **Bahasa Indonesia**. Zona waktu tampilan: **WIB (Asia/Jakarta)**.

## Sumber kebenaran desain

`prototype/trading-floor.html` adalah prototipe yang sudah disetujui (satu file HTML, Canvas 2D, data di memori).
Port tampilan dan perilakunya ke Next.js. Jangan desain ulang dari nol.

- Token warna, font (Pixelify Sans, IBM Plex Sans, IBM Plex Mono), dan layout ada di blok `:root` prototipe. Pakai nilai yang sama.
- Renderer isometrik (`iso()`, `drawBox`, depth sort, pathfinding BFS antar pintu, mode malam ikut jam WIB) dipindah apa adanya ke modul TypeScript. Tidak perlu PixiJS.
- Yang diganti hanya **sumber data**: konstanta `store`, `CATATAN`, `DEMO`, dan approval contoh di prototipe diganti data asli dari `office/`.
- Mode demo tetap ada sebagai toggle, untuk saat `office/` kosong.

## Hubungan dengan folder lain

```
C:\Users\user\trading\
├─ trading-floor-engine\   ← engine kuant + bot. JANGAN diubah dari project ini.
│  └─ office\              ← SATU-SATUNYA sumber data UI (lihat kontrak di bawah)
├─ trading-floor-ui\       ← project ini
└─ dashboard\              ← dashboard Bybit lama, project terpisah. Jangan disentuh.
```

Path `office/` diatur lewat env `OFFICE_DIR` di `.env.local`. Default: `../trading-floor-engine/office`.
Path relatif selalu di-resolve dengan `path.resolve(process.cwd(), …)`. Ini Windows, jadi jangan menyusun path dengan `/` manual.

## Aturan keras (jangan pernah dilanggar)

1. **UI tidak pernah mengirim order** dan tidak pernah memanggil API trading exchange. Tidak ada kode yang mengimpor `src/exec/*` dari engine.
2. **UI tidak membaca atau menulis `.env` engine**, API key, atau secret apa pun. Tidak ada route yang mengembalikan isi env.
3. **UI tidak mengubah `EXEC_MODE`** dan tidak menampilkan tombol untuk "go live".
4. **Satu-satunya file yang boleh ditulis UI**:
   - `office/approvals/<id>.json`: hanya field `status`, `catatanBos`, `decidedAt`
   - `office/inbox/<agent>/<file>.json`: hanya field `read`
   - `office/execution/STOP`: tombol kill switch, dengan konfirmasi di halaman (bukan `confirm()`)
5. **`watchlist.json` read-only di v1.** Promosi `watchlist.draft.json` ke `watchlist.json` mengubah apa yang ditradingkan bot, jadi tidak dibuat sampai Vivo memintanya secara eksplisit.
6. Semua tulisan file divalidasi dengan zod, ditulis atomik (tulis ke `.tmp` lalu `rename`), dan path-nya dicek tetap di dalam `OFFICE_DIR` (tolak `..`).
7. Aturan risiko hanya **ditampilkan**, dibaca dari tabel `office/RISK-RULES.md` (sumber kebenarannya `DEFAULT_RULES` di `trading-floor-engine/src/risk/engine.ts`). UI tidak boleh menawarkan nilai di atas batas itu.

## Kontrak data `office/` (kondisi sekarang)

Semua JSON dibaca dengan zod `safeParse`. File rusak atau tidak dikenal dilewati dan dicatat di log server; UI tidak boleh crash karenanya.

| Path | Penulis | Isi |
|---|---|---|
| `agents/<id>/status.json` | engine (saat ini hanya `lala`) | `{ id, nama, divisi, jabatan, state, bubble, updatedAt }` |
| `agents/<id>/CATATAN-<NAMA>.md` | engine | Markdown, dirender di panel samping |
| `inbox/<id>/*.json` | engine | `{ from, to, subject, body, createdAt, read }` |
| `backtests/scan-<stamp>.md` / `.json` | `npm run scan*` | Laporan scan. **`.json` bisa 40MB+** (lihat di bawah) |
| `debates/debate-<stamp>.md` / `.json` | `npm run debate` | `{ createdAt, …meta, results: DebateResult[] }`, verdict `go_paper` / `watch` / `reject`. Lihat `DebateResult` di `trading-floor-engine/src/agents/debate.ts` |
| `execution/log-YYYY-MM-DD.jsonl` | bot | Satu baris per event: `{ t, msg }` |
| `execution/state.json` | bot | `Record<"SYMBOL_tf_strategy", { position: BotPosition \| null, lastBarTime, dayKey, dayStartEquity }>`. Lihat `src/exec/state.ts` |
| `execution/watchlist.json` | Vivo (manual) | `[{ symbol, tf, strategyId, params? }]`, read-only |
| `execution/watchlist.draft.json` | engine | Format sama, usulan yang belum disetujui |
| `execution/STOP` | `npm run bot:stop` atau UI | Ada = kill switch aktif |
| `approvals/<id>.json` | **baru, dibuat UI** | Skema di bawah |

Mode bot (DRY_RUN atau LIVE) dibaca dari baris log `"Bot dimulai. Mode: …"` terbaru, bukan dari env.

### File scan besar

`scan-*.json` bisa puluhan MB. **Jangan pernah mengirimnya ke browser** dan jangan `JSON.parse` di setiap request.
Parse sekali di server (atau streaming), ambil ringkasan (top 20 baris: `symbol, tf, strategyId, verdict, oos.metrics` inti, `feasibility`), cache per `mtime`, lalu kirim ringkasan saja. Kalau parse terlalu berat, fallback ke tabel di file `.md` pasangannya.

### Skema approval (baru)

```ts
{
  id: string;                    // nama file tanpa .json
  from: "raka";
  type: "entry" | "watchlist";
  symbol: string; tf: "4h" | "1d"; strategyId: string;
  side?: "long" | "short"; entry?: number; sl?: number; tp?: number;
  riskPct: number; leverage: number;
  alasan: string; catatanRisk: string;
  status: "pending" | "approved" | "rejected";
  catatanBos?: string; createdAt: string; decidedAt?: string;
}
```

Saat ini engine belum membuat file approval. UI menyediakan route dan tampilannya, dan kalau folder kosong, meja approval menampilkan empty state yang menjelaskan bahwa approval akan muncul dari hasil debat. **Menyetujui approval hanya mengubah status file.** Tidak ada efek lain.

## Pemetaan agent ke data

Karena baru `lala` yang menulis `status.json`, status agent lain **diturunkan** di server. Urutannya: `status.json` kalau ada, lalu data turunan di bawah, lalu `idle`.

| Agent | Ruang | Diturunkan dari |
|---|---|---|
| Raka · Head Trader | Lobby | Pesan terbaru di `inbox/raka`, jumlah approval `pending` (ada pending → `waiting_approval`) |
| Sinta · Analis Teknikal | Ruang Riset | Scan terbaru: waktu, jumlah kombinasi, teratas |
| Bima · Analis Sentimen | Ruang Riset | Debat terbaru: jumlah `go_paper` / `watch` / `reject` |
| Dimas · Risk Manager | Risk Desk | `state.json` (posisi terbuka, exposure) + baris log "ditolak" hari ini; kill switch aktif → `alert` |
| Eko · Eksekutor | Execution Room | Log bot terbaru + mode DRY_RUN/LIVE. Lampu merah berkedip hanya kalau `state.json` punya `position` |
| Lala · Jurnal | Ruang Jurnal | `agents/lala/status.json` + `CATATAN-LALA.md`; papan jurnal = top scan |

Bubble ditulis singkat dan santai, maksimal sekitar 60 karakter, contohnya "Scan top100 selesai, 13 kandidat paper".

## Arsitektur yang diharapkan

- Next.js App Router + TypeScript strict. **Versi Next terbaru punya perubahan besar**: baca `node_modules/next/dist/docs/` sebelum menulis route/handler, dan ikuti `AGENTS.md` yang dibuat `next dev`.
- `src/lib/office/`: semua akses filesystem (hanya server). Satu modul per area (`agents.ts`, `inbox.ts`, `scans.ts`, `debates.ts`, `execution.ts`, `approvals.ts`), skema zod di `schemas.ts`.
- `src/app/api/office/snapshot/route.ts`: GET, satu snapshot lengkap yang sudah diringkas untuk render pertama.
- `src/app/api/office/events/route.ts`: SSE. `chokidar` mengawasi `OFFICE_DIR` (abaikan `*.tmp`, debounce 300ms) dan mengirim event `{ type, path }`. Klien lalu mengambil ulang bagian yang berubah.
- `src/app/api/office/approvals/[id]/route.ts`: POST `{ status, catatanBos }` dengan validasi aturan nomor 4 dan 6.
- `src/app/api/office/kill-switch/route.ts`: POST, membuat `execution/STOP`. Tidak ada endpoint untuk menghapusnya; menghapus STOP adalah keputusan manual Vivo.
- `src/app/api/market/route.ts` (opsional): harga terakhir simbol watchlist dari API publik Binance Futures `GET /fapi/v1/ticker/24hr`, cache 15 detik. Kalau gagal, fallback ke close terakhir di `../trading-floor-engine/data/<SYMBOL>_4h.json` dengan label "harga terakhir data".
- `src/components/floor/`: canvas isometrik (port dari prototipe), `Panel`, `ApprovalCard`, `Ticker`, `OfficeLog`, `RoomTabs`.
- Markdown CATATAN dirender dengan `react-markdown` + `remark-gfm` (tabel). HTML mentah tidak diizinkan.

## Tampilan per ruang

- **Lobby**: papan "Market Hari Ini" (harga simbol watchlist), resepsionis Raka.
- **Ruang Riset**: Sinta dan Bima; layar menampilkan teratas scan terakhir.
- **Risk Desk** (ruang kaca): exposure, drawdown hari ini, jumlah penolakan Risk Engine hari ini, status kill switch.
- **Execution Room**: mode DRY_RUN/LIVE dalam badge besar, watchlist aktif, 5 baris log terakhir, lampu posisi.
- **Ruang Meeting**: agent pindah ke sini saat ada debat baru (kurang dari 10 menit).
- **Ruang Jurnal**: easel/papan peringkat scan (OOS return vs hold), tombol buka laporan `.md`.
- **Lounge & Pool**: agent `idle`.
- **Ruang Bos**: meja approval, kill switch, ringkasan akun (equity, batas rugi harian 3%, risk 1%).

Equity yang ditampilkan berasal dari `NEXT_PUBLIC_DISPLAY_EQUITY` (default `81.01`) dan diberi label "equity spot (manual)" sampai ada sumber resmi.

## Perintah

```powershell
npm install
npm run dev        # http://localhost:3000
npm run lint
npm run build
```

Di PowerShell, argumen berisi koma atau akhiran seperti `1d` harus diberi tanda kutip.

## Definition of done untuk setiap perubahan

- `npm run lint` dan `npm run build` lolos tanpa error.
- Halaman tetap tampil normal saat: `office/` kosong, `office/` tidak ada, ada file JSON rusak, dan `scan-*.json` berukuran 40MB.
- Tidak ada request dari browser yang memuat lebih dari sekitar 500KB data office.
- Tidak ada kode yang menulis di luar daftar di aturan nomor 4. Cek dengan `grep -r "writeFile\|rename\|appendFile" src`.
- Tampilan dicek di lebar 1440px dan 390px, siang dan malam.

## Gaya kode

- TypeScript strict, tanpa `any`. Gunakan tipe dari skema zod (`z.infer`).
- Komponen klien seminimal mungkin; semua akses fs ada di server.
- Teks UI berbahasa Indonesia, kalimat pendek, istilah trading tetap dalam bahasa Inggris (long, short, stop loss, funding).
- Format angka: harga `en-US` dengan desimal sesuai simbol, persen 1 desimal, waktu `HH:mm WIB`.
