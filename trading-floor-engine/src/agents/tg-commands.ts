// Perintah Telegram untuk Trading Floor. Semua perintah HANYA MEMBACA file office/ + harga publik Binance,
// kecuali /stop_ya yang membuat file kill switch (sama dengan `npm run bot:stop`).
// Tidak ada perintah yang menyalakan bot, membuka posisi, atau memakai API key Binance.
import fs from "node:fs";
import path from "node:path";
import { fetchPremiumIndex } from "../data/binance.js";
import { loadWatchlist } from "../exec/watchlist.js";
import type { BotState } from "../exec/state.js";
import { TF_MS, type Timeframe } from "../types.js";
import { EXEC_DIR, equityPoints, logLinesBetween, tradeRecords, wibDay, wibTime } from "../ops/common.js";
import { liveCheck, liveReportText } from "../ops/livecheck.js";

export const COMMANDS: { cmd: string; desc: string }[] = [
  { cmd: "status", desc: "Bot hidup/mati, mode, kapan cek sinyal berikutnya" },
  { cmd: "posisi", desc: "Posisi terbuka + untung/rugi berjalan" },
  { cmd: "equity", desc: "Saldo terakhir dan perubahan hari ini" },
  { cmd: "log", desc: "8 kejadian terakhir dari bot" },
  { cmd: "trades", desc: "5 trade terakhir yang sudah selesai" },
  { cmd: "live", desc: "Hasil live dibanding backtest (strategi masih jalan normal?)" },
  { cmd: "watchlist", desc: "Koin & strategi yang dipantau bot" },
  { cmd: "stop", desc: "Kill switch darurat (minta konfirmasi)" },
  { cmd: "help", desc: "Daftar perintah" },
];

const STOP_CONFIRM_MS = 60_000;
const STALE_MS = 10 * 60_000;
let stopRequestedAt = 0;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const usd = (n: number) => `${n < 0 ? "−" : ""}$${Math.abs(n).toFixed(2)}`;
const signed = (n: number) => `${n >= 0 ? "+" : "−"}$${Math.abs(n).toFixed(2)}`;

export function helpText(): string {
  return [
    "🤖 <b>Perintah Trading Floor</b>",
    "",
    ...COMMANDS.map(c => `/${c.cmd} — ${esc(c.desc)}`),
    "",
    "Semua perintah cuma membaca data, kecuali /stop.",
    "/stop menghentikan bot (posisi + SL/TP di Binance tetap aktif). Menyalakan bot lagi hanya bisa dari laptop.",
  ].join("\n");
}

function readState(): BotState {
  try { return JSON.parse(fs.readFileSync(path.join(EXEC_DIR, "state.json"), "utf8")) as BotState; } catch { return {}; }
}

function recentLog(days = 2) {
  const now = Date.now();
  return logLinesBetween(now - days * 86_400_000, now + 60_000).sort((a, b) => a.t.localeCompare(b.t));
}

function nextCheck(now: number): number | null {
  const tfs = [...new Set(loadWatchlist().map(w => w.tf as Timeframe))].filter(tf => TF_MS[tf]);
  if (!tfs.length) return null;
  return Math.min(...tfs.map(tf => Math.ceil((now + 5_000) / TF_MS[tf]) * TF_MS[tf])) + 30_000;
}

function status(now: number): string {
  const lines = ["📊 <b>Status bot</b>"];
  let age: number | null = null;
  try { age = now - fs.statSync(path.join(EXEC_DIR, "state.json")).mtimeMs; } catch { /* belum pernah jalan */ }
  const stopped = fs.existsSync(path.join(EXEC_DIR, "STOP"));
  const log = recentLog();
  const start = [...log].reverse().find(l => l.msg.startsWith("Bot dimulai"));
  const kill = [...log].reverse().find(l => /Kill switch terdeteksi/.test(l.msg));
  const stoppedAfterStart = kill && start && kill.t > start.t;

  if (stopped) lines.push("⛔ Kill switch AKTIF (file STOP ada). Bot tidak akan jalan sampai file itu dihapus di laptop.");
  if (stoppedAfterStart) lines.push(`⏹️ Bot berhenti ${wibTime(kill.t)} WIB.`);
  else if (age === null) lines.push("❔ Bot belum pernah jalan.");
  else if (age > STALE_MS) lines.push(`⚠️ Bot TIDAK merespons: terakhir aktif ${Math.round(age / 60_000)} menit lalu. Cek laptop & terminal npm run bot.`);
  else {
    const up = start ? Math.max(0, Math.round((now - Date.parse(start.t)) / 60_000)) : null;
    const upText = up === null ? "" : ` sudah jalan ${up >= 60 ? `${Math.floor(up / 60)} jam ` : ""}${up % 60} menit,`;
    lines.push(`✅ Bot hidup:${upText} detak terakhir ${Math.max(0, Math.round(age / 60_000))} menit lalu (normal 0–1).`);
  }

  if (start) {
    const mode = /Mode: (\w+)/.exec(start.msg)?.[1] ?? "?";
    lines.push(`Mode: <b>${esc(mode)}</b>, dinyalakan ${wibDay(start.t)} ${wibTime(start.t)} WIB`);
    const auto = log.find(l => l.t >= start.t && /REQUIRE_APPROVAL=false/.test(l.msg));
    lines.push(auto ? "Entry: otomatis tanpa approval" : "Entry: butuh approval di Ruang Bos");
  }
  const open = Object.values(readState()).filter(s => s.position).length;
  lines.push(`Posisi terbuka: ${open}`);
  const nc = nextCheck(now);
  if (nc && !stopped && !stoppedAfterStart) lines.push(`Cek sinyal berikutnya: ${wibTime(nc)} WIB`);
  return lines.join("\n");
}

async function positions(): Promise<string> {
  const open = Object.entries(readState()).filter(([, s]) => s.position);
  if (!open.length) return "📭 <b>Tidak ada posisi terbuka</b> yang dicatat bot.\n<i>Posisi yang kamu buka manual di Binance tidak terlihat di sini.</i>";
  const out = ["📈 <b>Posisi terbuka</b>"];
  let total = 0, priced = 0;
  for (const [key, s] of open) {
    const p = s.position!;
    const symbol = key.split("_")[0]!;
    let pnlLine = "harga sekarang tidak bisa diambil";
    try {
      const mark = (await fetchPremiumIndex(symbol)).markPrice;
      const pnl = (mark - p.entry) * p.qty * (p.side === "long" ? 1 : -1);
      total += pnl; priced++;
      pnlLine = `harga ${mark} · berjalan <b>${signed(pnl)}</b>${p.riskUsd > 0 ? ` (${(pnl / p.riskUsd >= 0 ? "+" : "")}${(pnl / p.riskUsd).toFixed(2)}R)` : ""}`;
    } catch { /* tampilkan tanpa PnL */ }
    out.push("",
      `<code>${esc(key.replace(/_/g, " "))}</code>`,
      `${p.side === "long" ? "🟢 LONG" : "🔴 SHORT"} ${p.qty} @ ${p.entry} · ${p.leverage}x`,
      `SL ${p.stop}${p.target !== undefined ? ` · TP ${p.target}` : " · TP trailing"} · risk ${usd(p.riskUsd)}`,
      pnlLine);
  }
  if (priced > 1) out.push("", `Total berjalan: <b>${signed(total)}</b>`);
  out.push("", "<i>Belum termasuk fee & funding.</i>");
  return out.join("\n");
}

function equity(): string {
  const pts = equityPoints();
  if (!pts.length) return "💰 Belum ada data equity. Bot mencatatnya tiap 5 menit kalau EQUITY_SNAPSHOT_MINUTES diisi.";
  const last = pts.at(-1)!;
  const day = wibDay(last.t);
  const start = [...pts].reverse().find(p => wibDay(p.t) < day)?.equity ?? pts.find(p => wibDay(p.t) === day)!.equity;
  const change = last.equity - start;
  return [
    "💰 <b>Equity</b>",
    `Sekarang: <b>${usd(last.equity)}</b> (${wibTime(last.t)} WIB)`,
    `Hari ini: ${signed(change)} (${start ? `${change >= 0 ? "+" : ""}${((change / start) * 100).toFixed(1)}%` : "-"}) dari ${usd(start)}`,
    "<i>Deposit/withdraw ikut terhitung sebagai perubahan.</i>",
  ].join("\n");
}

function log(): string {
  const lines = recentLog().slice(-8);
  if (!lines.length) return "📜 Belum ada log bot dalam 2 hari terakhir.";
  return ["📜 <b>8 kejadian terakhir</b>", ...lines.map(l => `<i>${wibTime(l.t)}</i> ${esc(l.msg.length > 220 ? `${l.msg.slice(0, 220)}…` : l.msg)}`)].join("\n\n");
}

function trades(): string {
  const all = tradeRecords();
  if (!all.length) return "🧾 Belum ada trade yang selesai.";
  const last = all.slice(-5).reverse();
  const total = all.reduce((s, t) => s + t.pnl, 0);
  const wins = all.filter(t => t.pnl > 0).length;
  return [
    "🧾 <b>Trade terakhir</b>",
    ...last.map(t => `${t.pnl >= 0 ? "✅" : "❌"} ${esc(t.symbol)} ${t.side} · ${signed(t.pnl)} (${t.r >= 0 ? "+" : ""}${t.r.toFixed(2)}R) · ${wibDay(t.t)} ${wibTime(t.t)}`),
    "",
    `Total ${all.length} trade · menang ${wins} · PnL ${signed(total)}`,
  ].join("\n");
}

function watchlist(): string {
  const w = loadWatchlist();
  if (!w.length) return "👀 Watchlist kosong.";
  return ["👀 <b>Watchlist</b>", ...w.map(x => `• ${esc(x.symbol)} ${esc(x.tf)} · ${esc(x.strategyId)}`)].join("\n");
}

function stopRequest(now: number): string {
  if (fs.existsSync(path.join(EXEC_DIR, "STOP"))) return "⛔ Kill switch sudah aktif.";
  stopRequestedAt = now;
  return "⚠️ <b>Yakin hentikan bot?</b>\nBot berhenti membuka posisi baru. Posisi + SL/TP yang sudah terpasang di Binance TETAP aktif.\n\nKirim /stop_ya dalam 60 detik untuk konfirmasi.";
}

function stopConfirm(now: number): string {
  if (!stopRequestedAt || now - stopRequestedAt > STOP_CONFIRM_MS) return "Tidak ada permintaan stop yang aktif. Kirim /stop dulu.";
  stopRequestedAt = 0;
  fs.mkdirSync(EXEC_DIR, { recursive: true });
  fs.writeFileSync(path.join(EXEC_DIR, "STOP"), `${new Date(now).toISOString()} — kill switch dari Telegram\n`);
  return "⛔ <b>Kill switch aktif.</b> Bot berhenti dalam ±1 menit.\nUntuk menyalakan lagi, di laptop: hapus office\\execution\\STOP lalu npm run bot.";
}

/** Balasan untuk satu pesan teks dari pemilik bot. */
export async function handleCommand(text: string, now = Date.now()): Promise<string> {
  const cmd = text.trim().split(/\s+/)[0]!.toLowerCase().replace(/@\w+$/, "");
  switch (cmd) {
    case "/start": case "/help": return helpText();
    case "/status": return status(now);
    case "/posisi": return positions();
    case "/equity": return equity();
    case "/log": return log();
    case "/trades": return trades();
    case "/live": return liveReportText(liveCheck());
    case "/watchlist": return watchlist();
    case "/stop": return stopRequest(now);
    case "/stop_ya": return stopConfirm(now);
    default: return cmd.startsWith("/") ? "Perintah tidak dikenal. Kirim /help untuk daftar perintah." : "Aku cuma mengerti perintah. Kirim /help untuk daftarnya.";
  }
}
