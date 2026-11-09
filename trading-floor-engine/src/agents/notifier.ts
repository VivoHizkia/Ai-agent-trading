// Notifikasi Telegram untuk Trading Floor.
// Proses terpisah dari bot.ts: hanya MEMBACA office/execution/log-*.jsonl dan equity.jsonl, lalu mengirim
// pesan ke Telegram. Tidak menyentuh order, API key Binance, atau logika trading. Kalau Telegram down,
// bot tetap jalan seperti biasa.
//
//   npm run notify          jalan terus (cek tiap 15 detik)
//   npm run notify:test     kirim satu pesan uji lalu keluar
//   npm run notify:chatid   tampilkan chat id dari pesan terakhir yang kamu kirim ke bot
//   npm run notify:commands kirim daftar perintah (/status, /posisi, /stop, …) ke Telegram lalu keluar
// Saat jalan terus, notifier juga menjawab perintah Telegram dari TELEGRAM_CHAT_ID saja (lihat tg-commands.ts).
//
// .env:  TELEGRAM_BOT_TOKEN=...   TELEGRAM_CHAT_ID=...
// opsional: NOTIFY_DAILY_LOSS_WARN_PCT=2  NOTIFY_DAILY_LOSS_LIMIT_PCT=3  NOTIFY_REJECTED=false
//           NOTIFY_DASHBOARD_URL=http://localhost:3000
import "dotenv/config";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { OFFICE_DIR } from "../report/office.js";
import { readCalendar, refreshCalendar } from "../ops/calendar.js";
import { refreshRegime, REGIME_LABEL } from "../ops/regime.js";
import { refreshCrowd } from "../ops/crowd.js";
import { buildWeeklyReview, reviewTelegram, weekStart, writeWeeklyReview } from "../ops/review.js";
import { labTelegram, runLab } from "../ops/lab.js";
import { discoverTelegram, type DiscoverResult } from "../ops/discover.js";
import { expectationsStale, liveCheck, liveReportText, liveTrades, streakWarningText } from "../ops/livecheck.js";
import { tuneWatchlist, tuningDue, tuningTelegram } from "../ops/tuning.js";
import { normalizeEquity, wibDay as wibDayOf, WIB_MS } from "../ops/common.js";
import { COMMANDS, handleCommand, helpText } from "./tg-commands.js";
import { generateHeadTraderReport, writeReport } from "./headtrader.js";
import { callMeeting } from "../ops/meeting.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? "";
const API = (process.env.TELEGRAM_API_BASE ?? "https://api.telegram.org").replace(/\/$/, "");
const POLL_MS = Number(process.env.NOTIFY_POLL_SECONDS ?? 15) * 1000;
const WARN_PCT = Number(process.env.NOTIFY_DAILY_LOSS_WARN_PCT ?? 2);
const LIMIT_PCT = Number(process.env.NOTIFY_DAILY_LOSS_LIMIT_PCT ?? 3);
const NOTIFY_REJECTED = process.env.NOTIFY_REJECTED === "true";
const NOTIFY_CHECKS = process.env.NOTIFY_CHECKS !== "false"; // ringkasan tiap cek candle (6x sehari untuk 4h)
const DASHBOARD_URL = process.env.NOTIFY_DASHBOARD_URL ?? "";
const BOT_STALE_MS = Number(process.env.BOT_STALE_MINUTES ?? 10) * 60_000;
const NEWS_ALERT_MS = Number(process.env.NEWS_ALERT_MINUTES ?? 30) * 60_000;
const CALENDAR_EVERY_MS = 60 * 60_000;
const REGIME_EVERY_MS = Number(process.env.REGIME_REFRESH_MINUTES ?? 30) * 60_000;
const CROWD_EVERY_MS = Number(process.env.CROWD_REFRESH_MINUTES ?? 30) * 60_000;
const WEEKLY_LAB = process.env.WEEKLY_LAB !== "false";
const WEEKLY_DISCOVER = process.env.WEEKLY_DISCOVER !== "false";
/** AI (Gemini/OpenRouter/Anthropic) terpasang? Kalau tidak, fitur AI otomatis dilewati diam-diam. */
const AI_ON = Boolean(process.env.GEMINI_API_KEY || process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY);
const HEADTRADER_AUTO = AI_ON && process.env.HEADTRADER_AUTO !== "false";   // laporan 07:00 & 15:00 WIB
const WEEKLY_DEBATE = AI_ON && process.env.WEEKLY_DEBATE !== "false";       // debat AI atas kandidat scan mingguan
const TELEGRAM_ON = Boolean(TOKEN && CHAT_ID);

const EXEC_DIR = path.join(OFFICE_DIR, "execution");
const STATE_FILE = path.join(EXEC_DIR, "notifier-state.json");
const EQUITY_FILE = path.join(EXEC_DIR, "equity.jsonl");

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const wibTime = (iso: string) => new Date(Date.parse(iso) + 7 * 3_600_000).toISOString().slice(11, 16);
const wibDay = (iso: string) => new Date(Date.parse(iso) + 7 * 3_600_000).toISOString().slice(0, 10);
const usd = (n: number) => `$${n.toFixed(2)}`;

function out(line: string) {
  console.log(`[${new Date().toISOString()}] ${line}`);
}

/* ------------------------------------------------------------------ aturan pesan */

interface Rule { re: RegExp; icon: string; title: string; withEquity?: boolean; enabled?: (msg: string) => boolean }
// Urutan penting: aturan pertama yang cocok yang dipakai.
const RULES: Rule[] = [
  { re: /KRITIS|FATAL/, icon: "🚨", title: "KRITIS — cek sekarang" },
  { re: /GAGAL|ERROR/, icon: "🔴", title: "Error di bot" },
  { re: /Kill switch terdeteksi/, icon: "⛔", title: "Kill switch: bot berhenti" },
  { re: /: jurnal — .*PnL \+/, icon: "✅", title: "Trade selesai: untung", withEquity: true },
  { re: /: jurnal — .*PnL -/, icon: "❌", title: "Trade selesai: rugi", withEquity: true },
  { re: /LIVE entry/, icon: "🟢", title: "Entry baru (LIVE)", withEquity: true },
  { re: /DRY RUN — akan buka/, icon: "🧪", title: "Entry simulasi (dry run)" },
  { re: /LIVE tutup posisi|sudah tertutup di exchange/, icon: "🏁", title: "Posisi tertutup", withEquity: true },
  { re: /LIVE stop diketatkan/, icon: "🛡️", title: "Stop loss diketatkan" },
  { re: /menunggu approval manusia/, icon: "🟡", title: "Butuh izin Bos" },
  { re: /Bot dimulai/, icon: "▶️", title: "Bot mulai jalan" },
  { re: /^Transfer (masuk|keluar)/, icon: "💵", title: "Deposit / penarikan", withEquity: true },
  // Strategi 1h membuat bot cek tiap jam. Ringkasan "tidak ada sinyal" hanya dikirim di jam candle 4h (03/07/11/15/19/23 WIB)
  // supaya Telegram tidak dapat 24 pesan sehari; cek yang ada kejadiannya tetap selalu dikirim.
  { re: /^Cek sinyal .* selesai/, icon: "🕓", title: "Cek sinyal rutin", enabled: msg => NOTIFY_CHECKS && (/ada kejadian/.test(msg) || [3, 7, 11, 15, 19, 23].includes(Number(/^Cek sinyal (\d{2}):00/.exec(msg)?.[1] ?? -1))) },
  { re: /ditolak/, icon: "⚪", title: "Sinyal ditolak Risk Engine", enabled: () => NOTIFY_REJECTED },
];

function formatLine(t: string, msg: string): string | null {
  const rule = RULES.find(r => r.re.test(msg));
  if (!rule || (rule.enabled && !rule.enabled(msg))) return null;
  const m = /^([A-Z0-9]+USDT)[_ ](\d+[mhdwM])[_ ]([\w-]+):\s*(.*)$/.exec(msg);
  const head = `${rule.icon} <b>${esc(rule.title)}</b>`;
  const body = m ? `<code>${esc(`${m[1]} ${m[2]} ${m[3]}`)}</code>\n${esc(m[4]!)}` : esc(msg);
  let extra = "";
  if (rule.withEquity) {
    const eq = equityToday();
    if (eq) extra = `\nEquity ${usd(eq.last)} · hari ini ${eq.change >= 0 ? "+" : "−"}${usd(Math.abs(eq.change))} (${eq.pct >= 0 ? "+" : ""}${eq.pct.toFixed(1)}%)`;
  }
  if (rule.title.startsWith("Butuh izin") && DASHBOARD_URL) extra += `\n<a href="${esc(DASHBOARD_URL)}">Buka Ruang Bos</a>`;
  return `${head}\n${body}${extra}\n<i>${wibTime(t)} WIB</i>`;
}

/* ------------------------------------------------------------------ equity */

function equityToday(): { last: number; start: number; change: number; pct: number; day: string; mode: string } | null {
  let text: string;
  try {
    const st = fs.statSync(EQUITY_FILE);
    const n = Math.min(st.size, 256 * 1024);
    const fd = fs.openSync(EQUITY_FILE, "r");
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, st.size - n);
    fs.closeSync(fd);
    text = buf.toString("utf8");
  } catch {
    return null;
  }
  const pts: { t: string; equity: number; mode: string }[] = [];
  for (const line of text.split("\n")) {
    try {
      const j = JSON.parse(line);
      if (typeof j.t === "string" && Number.isFinite(j.equity)) pts.push({ t: j.t, equity: j.equity, mode: j.mode ?? "?" });
    } catch { /* baris pertama bisa terpotong, abaikan */ }
  }
  if (!pts.length) return null;
  const mode = pts.at(-1)!.mode;
  // Deposit/penarikan dinetralkan: perubahan hari ini = untung/rugi trading saja.
  const same = normalizeEquity(pts.filter(p => p.mode === mode));
  const last = same.at(-1)!;
  const day = wibDay(last.t);
  const start = same.filter(p => wibDay(p.t) < day).at(-1)?.equity ?? same.find(p => wibDay(p.t) === day)!.equity;
  const change = last.equity - start;
  return { last: last.equity, start, change, pct: start ? (change / start) * 100 : 0, day, mode };
}

/* ------------------------------------------------------------------ state */

interface State {
  offsets: Record<string, number>;
  lossAlert: Record<string, "warn" | "limit">;
  botAlive?: boolean;
  newsSent?: string[];
  lastCalendarAt?: number;
  lastRegimeAt?: number;
  lastCrowdAt?: number;
  crowdFlags?: Record<string, string>;
  fngZone?: string;
  fits?: Record<string, string>;
  lastReviewWeek?: string;
  lastLabWeek?: string;
  lastDiscoverWeek?: string;
  /** Jumlah trade live saat laporan live-vs-backtest terakhir dikirim. */
  liveReportedN?: number;
  /** Jumlah trade live saat peringatan kalah beruntun terakhir dikirim. */
  streakAlertN?: number;
  lastHeadTrader?: string;
}

function loadState(): State | null {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as State; } catch { return null; }
}
function saveState(s: State) {
  fs.mkdirSync(EXEC_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}
const logFiles = () => {
  try { return fs.readdirSync(EXEC_DIR).filter(f => /^log-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort(); } catch { return []; }
};
const sizeOf = (f: string) => { try { return fs.statSync(path.join(EXEC_DIR, f)).size; } catch { return 0; } };

/** Baris baru sejak offset terakhir. Baris yang belum lengkap (sedang ditulis bot) ditunda ke putaran berikutnya. */
function readNewLines(file: string, from: number): { lines: { t: string; msg: string }[]; next: number } {
  const size = sizeOf(file);
  if (size < from) from = 0; // file diganti/terpotong
  if (size === from) return { lines: [], next: from };
  const fd = fs.openSync(path.join(EXEC_DIR, file), "r");
  const buf = Buffer.alloc(size - from);
  fs.readSync(fd, buf, 0, buf.length, from);
  fs.closeSync(fd);
  const text = buf.toString("utf8");
  const end = text.lastIndexOf("\n");
  if (end < 0) return { lines: [], next: from };
  const lines: { t: string; msg: string }[] = [];
  for (const l of text.slice(0, end).split("\n")) {
    try {
      const j = JSON.parse(l);
      if (typeof j.t === "string" && typeof j.msg === "string") lines.push(j);
    } catch { /* baris rusak dilewati */ }
  }
  return { lines, next: from + Buffer.byteLength(text.slice(0, end + 1), "utf8") };
}

/* ------------------------------------------------------------------ telegram */

const queue: string[] = [];

async function tg(method: string, body?: unknown, timeoutMs = 15_000): Promise<{ ok: boolean; result?: unknown; description?: string; parameters?: { retry_after?: number } }> {
  const res = await fetch(`${API}/bot${TOKEN}/${method}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res.json() as Promise<{ ok: boolean; result?: unknown; description?: string; parameters?: { retry_after?: number } }>;
}

async function send(text: string): Promise<boolean> {
  try {
    const r = await tg("sendMessage", { chat_id: CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true });
    if (r.ok) return true;
    if (r.parameters?.retry_after) await sleep(r.parameters.retry_after * 1000);
    out(`Telegram menolak: ${r.description ?? "?"}`);
    return false;
  } catch (e) {
    out(`Gagal kirim ke Telegram: ${(e as Error).message}`);
    return false;
  }
}

/** Gabung pesan supaya tidak spam, maksimal ~3800 karakter per kiriman. Yang gagal dicoba lagi putaran berikutnya. */
async function flush() {
  if (!TELEGRAM_ON) { for (const m of queue.splice(0)) out(`(Telegram belum diatur) ${m.replace(/<[^>]+>/g, "").replace(/\n/g, " | ")}`); return; }
  while (queue.length) {
    let text = queue[0]!;
    let n = 1;
    while (n < queue.length && text.length + queue[n]!.length + 2 < 3800) { text += "\n\n" + queue[n]; n++; }
    if (!(await send(text))) return;
    queue.splice(0, n);
    await sleep(1100);
  }
}

/* ------------------------------------------------------------------ perintah dari Telegram */

type Update = { update_id: number; message?: { chat: { id: number }; text?: string } };

async function registerCommands() {
  const r = await tg("setMyCommands", { commands: COMMANDS.map(c => ({ command: c.cmd, description: c.desc })) }).catch(() => null);
  if (!r?.ok) out(`Menu perintah Telegram gagal didaftarkan: ${r?.description ?? "tidak ada respons"}`);
}

/** Long-polling getUpdates. Hanya chat TELEGRAM_CHAT_ID yang dilayani; pesan dari chat lain diabaikan. */
async function commandLoop() {
  await registerCommands();
  // Lewati pesan yang menumpuk sebelum notifier jalan, supaya perintah lama (mis. /stop_ya) tidak tereksekusi.
  let offset = 0;
  try {
    const r = await tg("getUpdates", { offset: -1, timeout: 0 });
    const last = (r.result as Update[] | undefined)?.at(-1);
    if (last) offset = last.update_id + 1;
  } catch { /* mulai dari 0 */ }
  out("Perintah Telegram aktif (/help).");
  for (;;) {
    try {
      const r = await tg("getUpdates", { offset, timeout: 25, allowed_updates: ["message"] }, 35_000);
      if (!r.ok) { out(`getUpdates ditolak: ${r.description ?? "?"}`); await sleep(10_000); continue; }
      for (const u of (r.result as Update[] | undefined) ?? []) {
        offset = u.update_id + 1;
        const msg = u.message;
        if (!msg?.text) continue;
        if (String(msg.chat.id) !== CHAT_ID) { out(`Pesan dari chat lain (${msg.chat.id}) diabaikan.`); continue; }
        out(`Perintah: ${msg.text.slice(0, 40)}`);
        let reply: string;
        try { reply = await handleCommand(msg.text); } catch (e) { reply = `Gagal menjalankan perintah: ${esc((e as Error).message)}`; }
        await send(reply);
      }
    } catch (e) {
      out(`Perintah Telegram: ${(e as Error).message}`);
      await sleep(5_000);
    }
  }
}

/* ------------------------------------------------------------------ main */

async function poll(state: State) {
  const files = logFiles().slice(-2);
  for (const f of files) {
    const { lines, next } = readNewLines(f, state.offsets[f] ?? 0);
    state.offsets[f] = next;
    for (const l of lines) {
      const msg = formatLine(l.t, l.msg);
      if (msg) queue.push(msg);
    }
  }
  // buang offset file lama supaya state tidak membengkak
  for (const k of Object.keys(state.offsets)) if (!files.includes(k)) delete state.offsets[k];

  const eq = equityToday();
  if (eq && eq.mode.toLowerCase() === "live" && eq.pct < 0) {
    const loss = -eq.pct;
    const already = state.lossAlert[eq.day];
    const level = loss >= LIMIT_PCT ? "limit" : loss >= WARN_PCT ? "warn" : null;
    if (level && already !== "limit" && already !== level) {
      state.lossAlert = { [eq.day]: level };
      callMeeting("darurat", level === "limit" ? "Rapat darurat: batas rugi" : "Rapat darurat: rugi harian",
        `Rugi hari ini ${loss.toFixed(1)}% (batas ${LIMIT_PCT}%). Equity ${usd(eq.last)}.${level === "limit" ? " Entry baru ditolak sampai besok." : ""}`,
        ["raka", "rini"]);
      queue.push(level === "limit"
        ? `🛑 <b>Batas rugi harian tercapai</b>\nEquity ${usd(eq.last)}, turun ${usd(-eq.change)} (−${loss.toFixed(1)}%) dari awal hari ${usd(eq.start)}.\nRisk Engine akan menolak entry baru sampai besok.`
        : `⚠️ <b>Rugi harian mendekati batas</b>\nEquity ${usd(eq.last)}, turun ${usd(-eq.change)} (−${loss.toFixed(1)}%) hari ini. Batas: ${LIMIT_PCT}%.`);
    }
  }
  await services(state);
  saveState(state);
  await flush();
}

/* ------------------------------------------------------------------ layanan kantor */

const wibNow = () => { const d = new Date(Date.now() + WIB_MS); return { dow: d.getUTCDay(), hour: d.getUTCHours() }; };

async function headTraderIfDue(state: State, now: number) {
  if (!HEADTRADER_AUTO) return;
  const { hour } = wibNow();
  const slot: "pagi" | "sore" | null = hour >= 7 && hour < 10 ? "pagi" : hour >= 15 && hour < 18 ? "sore" : null;
  if (!slot) return;
  const key = `${wibDayOf(now)}-${slot}`;
  if (state.lastHeadTrader === key) return;
  state.lastHeadTrader = key;
  saveState(state);
  try {
    const text = await generateHeadTraderReport();
    const file = writeReport(slot, text);
    out(`Laporan Head Trader ${slot} ditulis: ${file}`);
    callMeeting("briefing", `Briefing ${slot} ${slot === "pagi" ? "07:00" : "15:00"}`, text, ["raka", "tio", "sendi", "rini", "lala"]);
    queue.push(`🧑‍💼 <b>Laporan Head Trader (${slot === "pagi" ? "07:00" : "15:00"} WIB)</b>\n${esc(text.slice(0, 3500))}`);
  } catch (e) { out(`Head Trader: ${(e as Error).message}`); }
}

async function services(state: State) {
  const now = Date.now();

  // 1) Ruang Server: bot dianggap hidup kalau execution/state.json masih diperbarui (bot menyimpannya tiap ~1 menit).
  try {
    const st = fs.statSync(path.join(EXEC_DIR, "state.json"));
    const age = now - st.mtimeMs;
    const stopped = fs.existsSync(path.join(EXEC_DIR, "STOP"));
    if (age > BOT_STALE_MS && state.botAlive !== false && !stopped) {
      state.botAlive = false;
      queue.push(`⚠️ <b>Bot tidak merespons</b>
execution/state.json terakhir diperbarui ${Math.round(age / 60_000)} menit lalu (${wibTime(st.mtime.toISOString())} WIB). Cek PC, internet, dan terminal <code>npm run bot</code>.
SL/TP yang sudah terpasang di Binance tetap aktif.`);
    } else if (age <= BOT_STALE_MS) {
      if (state.botAlive === false) queue.push(`✅ <b>Bot jalan lagi</b>
execution/state.json diperbarui ${wibTime(st.mtime.toISOString())} WIB.`);
      state.botAlive = true;
    }
  } catch { /* bot belum pernah jalan */ }

  // 2) Meja Berita: perbarui kalender tiap jam, kabari 30 menit sebelum berita high-impact.
  if (now - (state.lastCalendarAt ?? 0) > CALENDAR_EVERY_MS) {
    state.lastCalendarAt = now;
    try { const c = await refreshCalendar(); out(c ? `Kalender diperbarui: ${c.events.length} berita` : "Kalender: sumber tidak bisa diakses, pakai data lama"); } catch (e) { out(`Kalender: ${(e as Error).message}`); }
  }
  const cal = readCalendar();
  if (cal) {
    state.newsSent ??= [];
    for (const e of cal.events) {
      if (e.impact !== "High") continue;
      const d = Date.parse(e.at) - now;
      const id = `${e.at}|${e.title}`;
      if (d > 0 && d <= NEWS_ALERT_MS && !state.newsSent.includes(id)) {
        state.newsSent.push(id);
        queue.push(`📰 <b>Berita besar ${Math.round(d / 60_000)} menit lagi</b>
${esc(e.country)} · ${esc(e.title)} · ${wibTime(e.at)} WIB${e.forecast ? `
Forecast ${esc(e.forecast)} · sebelumnya ${esc(e.previous)}` : ""}
Harga bisa bergerak liar di sekitar jam ini.`);
      }
    }
    state.newsSent = state.newsSent.slice(-60);
  }

  // 3) Ruang Regime: hitung ulang tiap 30 menit, kabari kalau strategi live jadi kurang cocok dengan pasarnya.
  if (now - (state.lastRegimeAt ?? 0) > REGIME_EVERY_MS) {
    state.lastRegimeAt = now;
    try {
      const r = await refreshRegime();
      if (r) {
        const prev = state.fits ?? {};
        const next: Record<string, string> = {};
        for (const f of r.fits) {
          const k = `${f.symbol} ${f.tf} ${f.strategyId}`;
          next[k] = f.fit;
          if (prev[k] && prev[k] !== f.fit && f.fit === "kurang cocok") {
            callMeeting("darurat", "Rapat darurat: regime berubah", `${k} sekarang kurang cocok: pasar ${REGIME_LABEL[f.regime].toLowerCase()}. ${f.note}`, ["raka", "rini"]);
            queue.push(`🧭 <b>Regime berubah</b>
<code>${esc(k)}</code> sekarang <b>kurang cocok</b>: pasar ${REGIME_LABEL[f.regime].toLowerCase()}.
${esc(f.note)}`);
          }
        }
        state.fits = next;
      }
    } catch (e) { out(`Regime: ${(e as Error).message}`); }
  }

  // 3b) Data crowd (funding, OI, long/short, Fear & Greed): tiap 30 menit, kabari kalau sebuah simbol jadi "ramai".
  if (now - (state.lastCrowdAt ?? 0) > CROWD_EVERY_MS) {
    state.lastCrowdAt = now;
    try {
      const c = await refreshCrowd();
      if (c) {
        const prev = state.crowdFlags ?? {};
        const next: Record<string, string> = {};
        for (const r of c.rows) {
          next[r.symbol] = r.flag;
          if (r.flag !== "normal" && prev[r.symbol] !== r.flag) {
            callMeeting("darurat", `Rapat darurat: ${r.symbol.replace("USDT", "")} ${r.flag}`, r.note, ["raka", "rini"]);
            queue.push(`👥 <b>${esc(r.symbol)}: ${esc(r.flag)}</b>
${esc(r.note)}
funding ${r.funding != null ? (r.funding * 100).toFixed(4) + "%" : "?"} · OI 24j ${r.oiChg24h != null ? r.oiChg24h.toFixed(1) + "%" : "?"} · L/S ${r.lsRatio?.toFixed(2) ?? "?"}`);
          }
        }
        const fg = c.fearGreed?.value;
        const zone = fg == null ? "" : fg <= 20 ? "extreme fear" : fg >= 80 ? "extreme greed" : "";
        if (zone && state.fngZone !== zone) queue.push(`😱 <b>Fear & Greed ${fg}</b> (${zone})\nSentimen pasar crypto sedang ekstrem. Sumber: alternative.me`);
        state.fngZone = zone;
        state.crowdFlags = next;
      }
    } catch (e) { out(`Crowd: ${(e as Error).message}`); }
  }

  // 3c) Laporan Head Trader (AI) jam 07:00 & 15:00 WIB.
  await headTraderIfDue(state, now);

  // 4) Review mingguan (Minggu >= 21:00 WIB) dan 5) Lab R&D (Minggu >= 08:00 WIB), masing-masing sekali per minggu.
  const { dow, hour } = wibNow();
  const week = wibDayOf(weekStart(now));
  if (dow === 0 && hour >= 21 && state.lastReviewWeek !== week) {
    state.lastReviewWeek = week;
    try { const r = buildWeeklyReview(now); writeWeeklyReview(r); queue.push(reviewTelegram(r)); out(`Review mingguan ${r.week} ditulis`); } catch (e) { out(`Review: ${(e as Error).message}`); }
  }
  if (WEEKLY_LAB && dow === 0 && hour >= 8 && state.lastLabWeek !== week) {
    state.lastLabWeek = week;
    saveState(state);
    try { const { rows } = await runLab(m => out(m)); if (rows.length) queue.push(labTelegram(rows)); } catch (e) { out(`Lab: ${(e as Error).message}`); }
  }
  // 6) Scan penemuan top 100 (Minggu >= 10:00 WIB). Proses terpisah: walk-forward ratusan kombinasi berat di CPU
  //    dan tidak boleh membuat perintah Telegram / pantauan bot macet selama scan berjalan.
  if (WEEKLY_DISCOVER && dow === 0 && hour >= 10 && state.lastDiscoverWeek !== week) {
    state.lastDiscoverWeek = week;
    saveState(state);
    startDiscover();
  }

  // 7) Penyetelan setelan strategi tiap 90 hari (dan untuk baris watchlist baru). Ringan: satu jendela 365 hari per baris.
  if (tuningDue(now) && now - lastTuneTry > 60 * 60_000) {
    lastTuneTry = now;
    try { const ch = await tuneWatchlist({ onProgress: m => out(`Penyetelan: ${m}`) }); if (ch.length) queue.push(tuningTelegram(ch)); }
    catch (e) { out(`Penyetelan: ${(e as Error).message}`); }
  }

  // 8) Live vs backtest: laporan tiap 10 trade live + peringatan kalah beruntun yang tidak wajar menurut backtest.
  //    Pembanding (walk-forward per baris watchlist) dibuat ulang tiap 7 hari di proses terpisah supaya notifier tidak macet.
  if (expectationsStale(now) && now - lastExpectTry > 60 * 60_000) {
    lastExpectTry = now;
    startJob("Pembanding live vs backtest", ["livecheck", "--quiet"]);
  }
  const n = liveTrades().length;
  if (n !== lastLiveN) {
    lastLiveN = n;
    const c = liveCheck();
    if (c.n >= 10 && Math.floor(c.n / 10) > Math.floor((state.liveReportedN ?? 0) / 10)) {
      state.liveReportedN = c.n;
      queue.push(liveReportText(c));
    }
    if (c.streak >= 3 && c.streakP < 0.01 && state.streakAlertN !== c.n) {
      state.streakAlertN = c.n;
      queue.push(streakWarningText(c));
    }
  }
}
let lastExpectTry = 0;
let lastTuneTry = 0;
let lastLiveN = -1;

/** Jalankan `run.ts <args>` di proses terpisah (pekerjaan berat CPU); hasilnya hanya dicatat di terminal. */
const jobsRunning = new Set<string>();
function startJob(label: string, args: string[]) {
  if (jobsRunning.has(label)) return;
  jobsRunning.add(label);
  const child = spawn(process.execPath, ["--import", "tsx", "src/ops/run.ts", ...args], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", d => { stderr += d; });
  child.on("exit", code => {
    jobsRunning.delete(label);
    out(code === 0 ? `${label}: selesai` : `${label}: gagal (${stderr.trim().split("\n").at(-1) || `kode ${code}`})`);
  });
}

let discoverRunning = false;
function startDiscover() {
  if (discoverRunning) return;
  discoverRunning = true;
  out("Scan mingguan top koin dimulai (beberapa menit)...");
  const child = spawn(process.execPath, ["--import", "tsx", "src/ops/run.ts", "discover", "--quiet"], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", d => { stdout += d; });
  child.stderr.on("data", d => { stderr += d; });
  child.on("exit", code => {
    discoverRunning = false;
    const file = /Ditulis: (.+)/.exec(stdout)?.[1]?.trim();
    try {
      if (code !== 0 || !file) throw new Error(stderr.trim().split("\n").at(-1) || `keluar dengan kode ${code}`);
      queue.push(discoverTelegram(JSON.parse(fs.readFileSync(file, "utf8")) as DiscoverResult));
      out(`Scan mingguan selesai: ${file}`);
      startDebate();
    } catch (e) { out(`Scan mingguan gagal: ${(e as Error).message}`); }
  });
}

/** Debat bull/bear AI atas kandidat teratas hasil scan mingguan. Proses terpisah, hasil ke office/debates + Telegram. */
let debateRunning = false;
function startDebate() {
  if (!WEEKLY_DEBATE || debateRunning) return;
  debateRunning = true;
  out("Debat AI atas kandidat scan dimulai...");
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "debate", "--top", process.env.WEEKLY_DEBATE_TOP ?? "5"], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", d => { stdout += d; });
  child.stderr.on("data", d => { stderr += d; });
  child.on("exit", code => {
    debateRunning = false;
    if (/Tidak ada kandidat/.test(stdout)) { out("Debat: tidak ada kandidat lolos scan."); return; }
    const md = /Laporan debat: (.+)/.exec(stdout)?.[1]?.trim();
    try {
      if (code !== 0 || !md) throw new Error(stderr.trim().split("\n").at(-1) || `keluar dengan kode ${code}`);
      const d = JSON.parse(fs.readFileSync(md.replace(/\.md$/, ".json"), "utf8")) as { results: { symbol: string; tf: string; strategyId: string; verdict: string; confidence: string; reasoning: string }[] };
      const icon: Record<string, string> = { go_paper: "🟢", watch: "🟡", reject: "⛔" };
      queue.push([`🗣️ <b>Debat AI kandidat mingguan</b>`, ...d.results.map(r => `${icon[r.verdict] ?? "•"} <code>${esc(`${r.symbol} ${r.tf} ${r.strategyId}`)}</code> ${esc(r.verdict)} (${esc(r.confidence)})\n${esc(r.reasoning)}`),
        "Saran saja: watchlist tetap diubah manual."].join("\n"));
      out(`Debat selesai: ${md}`);
    } catch (e) { out(`Debat gagal: ${(e as Error).message}`); }
  });
}

async function main() {
  const arg = process.argv[2];
  if (!TOKEN && (arg === "--chatid" || arg === "--test")) {
    console.log("TELEGRAM_BOT_TOKEN belum diisi di .env. Buat bot lewat @BotFather di Telegram, lalu salin token-nya ke .env.");
    process.exit(1);
  }
  if (arg === "--chatid") {
    const me = await tg("getMe");
    if (!me.ok) {
      console.log(`Token ditolak Telegram: ${me.description ?? "tidak diketahui"}. Cek TELEGRAM_BOT_TOKEN di .env (tanpa spasi/tanda kutip).`);
      process.exit(1);
    }
    const bot = me.result as { username?: string };
    console.log(`Token valid untuk bot @${bot.username ?? "?"}`);
    let r = await tg("getUpdates");
    if (!r.ok && /webhook/i.test(r.description ?? "")) {
      console.log("Bot ini masih punya webhook aktif, menghapusnya supaya bisa membaca pesan…");
      await tg("deleteWebhook");
      r = await tg("getUpdates");
    }
    if (!r.ok) {
      console.log(`Telegram menolak getUpdates: ${r.description ?? "tidak diketahui"}`);
      process.exit(1);
    }
    type Chat = { id: number; first_name?: string; title?: string; username?: string };
    type Upd = { message?: { chat: Chat }; edited_message?: { chat: Chat }; my_chat_member?: { chat: Chat }; channel_post?: { chat: Chat } };
    const updates = (r.result as Upd[] | undefined) ?? [];
    const found = updates.map(u => (u.message ?? u.edited_message ?? u.my_chat_member ?? u.channel_post)?.chat).filter((c): c is Chat => !!c);
    const chats = [...new Map(found.map(c => [c.id, c])).values()];
    if (!chats.length) console.log(`Belum ada pesan untuk @${bot.username ?? "bot ini"}. Pastikan kamu chat ke bot yang SAMA dengan token ini, kirim "halo", lalu jalankan perintah ini lagi.`);
    for (const c of chats) console.log(`TELEGRAM_CHAT_ID=${c.id}   (${c.title ?? c.first_name ?? "chat"})`);
    return;
  }
  if (!CHAT_ID && arg === "--test") {
    console.log("TELEGRAM_CHAT_ID belum diisi. Kirim pesan ke bot kamu, lalu jalankan: npm run notify:chatid");
    process.exit(1);
  }
  if (!TELEGRAM_ON) out("Telegram belum diatur: layanan kantor (pantau bot, berita, regime, review, lab) tetap jalan, pesan hanya dicetak di terminal.");
  if (arg === "--commands") {
    await registerCommands();
    const ok = await send(helpText());
    console.log(ok ? "Daftar perintah terkirim ke Telegram." : "Gagal terkirim, lihat pesan error di atas.");
    // exitCode + return, bukan process.exit(): keluar paksa tepat setelah fetch memicu assertion libuv di Windows.
    process.exitCode = ok ? 0 : 1;
    return;
  }
  if (arg === "--test") {
    const eq = equityToday();
    const ok = await send(`🔔 <b>Tes notifikasi Trading Floor</b>\nKalau pesan ini sampai, notifikasi sudah siap.${eq ? `\nEquity terakhir ${usd(eq.last)} (${eq.mode})` : ""}`);
    console.log(ok ? "Terkirim. Cek Telegram kamu." : "Gagal terkirim, lihat pesan error di atas.");
    process.exit(ok ? 0 : 1);
  }

  let state = loadState();
  if (!state) {
    // Pertama kali jalan: mulai dari akhir log supaya riwayat lama tidak dikirim semua.
    state = { offsets: Object.fromEntries(logFiles().slice(-2).map(f => [f, sizeOf(f)])), lossAlert: {} };
    queue.push(`🔔 <b>Notifikasi Trading Floor aktif</b>\nKamu akan dapat kabar saat entry, trade selesai, error, kill switch, rugi harian mendekati ${LIMIT_PCT}%, bot berhenti merespons, berita besar 30 menit lagi, regime pasar berubah, plus review & Lab tiap Minggu.`);
  }
  out(`Notifier + layanan kantor jalan. Membaca ${EXEC_DIR} tiap ${POLL_MS / 1000} detik.`);
  if (TELEGRAM_ON) void commandLoop();
  for (;;) {
    try { await poll(state); } catch (e) { out(`ERROR: ${(e as Error).message}`); }
    await sleep(POLL_MS);
  }
}

main().catch(e => { out(`FATAL: ${(e as Error).message}`); process.exit(1); });
