// Bot eksekusi live 24/7 — PAKAI STRATEGI & RISK ENGINE YANG SAMA PERSIS dengan backtest.
// Default EXEC_MODE=dry_run: mencatat apa yang AKAN dilakukan, tidak kirim order sungguhan.
// Harus EXEC_MODE=live eksplisit baru benar-benar mengirim order ke Binance pakai uang asli.
// Kill switch: buat file office/execution/STOP untuk menghentikan bot (posisi+SL/TP yang sudah
// terpasang di exchange TETAP aktif karena itu order asli di Binance, bukan simulasi).
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fetchKlines, fetchSymbolFilters } from "../data/binance.js";
import { floorToStep, roundToTick } from "./rounding.js";
import { getStrategy } from "../strategies/index.js";
import { DEFAULT_RULES, evaluateRisk, REJECTION_LABEL } from "../risk/engine.js";

/** Aturan risiko per baris watchlist: riskPct baris hanya bisa menurunkan risk, tidak pernah menaikkan. */
function rulesFor(entry: { riskPct?: number }) {
  const r = Number(entry.riskPct);
  return Number.isFinite(r) && r > 0 && r < DEFAULT_RULES.riskPct ? { ...DEFAULT_RULES, riskPct: r } : DEFAULT_RULES;
}
import { marketSpec, TF_MS, type Position, type Timeframe } from "../types.js";
import { OFFICE_DIR, writeAgentStatus } from "../report/office.js";
import { BinanceUnknownResult, cancelAlgoOrder, cancelAllAlgoOpenOrders, closePositionMarket, getAccount, getAllPositions, getIncome, getIncomeAll, getLeverageBrackets, getOpenAlgoOrders, getPositionRisk, getUserTrades, isHedgeMode, newOrder, placeProtectiveOrder, setLeverage } from "./binance-trade.js";
import { loadState, saveState, watchKey, type BotPosition, type BotState, type WatchState } from "./state.js";
import { loadWatchlist, watchlistPath, writeWatchlistTemplate, type WatchlistEntry } from "./watchlist.js";
import { checkStatus, createApproval } from "./approvals.js";
import { activeBlackout } from "../ops/calendar.js";
import { tunedParams } from "../ops/tuning.js";
import { isStaleSignal, MAX_SIGNAL_AGE_MS, signalAgeMs } from "./signal-age.js";
import type { Params } from "../strategies/index.js";
import { crowdContext } from "../ops/crowd.js";

const EXEC_MODE = process.env.EXEC_MODE === "live" ? "live" : "dry_run";
const STOP_FILE = path.join(OFFICE_DIR, "execution", "STOP");
const DAY_OFFSET = 7 * 3_600_000; // WIB
const APPROVAL_TIMEOUT_MS = Number(process.env.APPROVAL_TIMEOUT_MINUTES ?? 30) * 60_000;
const REQUIRE_APPROVAL = process.env.REQUIRE_APPROVAL !== "false";
/** Opsional: catat equity tiap N menit sambil menunggu bar close (1 panggilan getAccount per N menit). 0 = mati. */
/** Opsional: tolak ENTRY BARU dalam N menit sebelum/sesudah berita high-impact (office/market/calendar.json). 0 = mati.
 * Exit, SL/TP, dan posisi yang sudah terbuka tidak terpengaruh. */
const NEWS_BLACKOUT_MS = Math.max(0, Number(process.env.NEWS_BLACKOUT_MINUTES ?? 0)) * 60_000;
/** Opsional: CROWD_FILTER=true menolak entry yang SEARAH dengan pasar yang sedang "ramai" (office/market/crowd.json).
 * Default mati: data crowd hanya dicatat sebagai konteks di log & jurnal. */
const CROWD_FILTER = process.env.CROWD_FILTER === "true";
const EQUITY_SNAPSHOT_MS = Math.max(0, Number(process.env.EQUITY_SNAPSHOT_MINUTES ?? 0)) * 60_000;

const filtersCache = new Map<string, { tickSize: string; stepSize: string }>();
async function filtersOf(symbol: string) {
  if (!filtersCache.has(symbol)) filtersCache.set(symbol, await fetchSymbolFilters(symbol));
  return filtersCache.get(symbol)!;
}

const bracketCache = new Map<string, Awaited<ReturnType<typeof getLeverageBrackets>>>();
/** Leverage Risk Engine dibatasi lagi oleh tier leverage ASLI exchange untuk notional ini (beda per simbol). */
async function clampToExchangeLeverage(symbol: string, leverage: number, notional: number): Promise<number> {
  if (!bracketCache.has(symbol)) bracketCache.set(symbol, await getLeverageBrackets(symbol));
  const brackets = bracketCache.get(symbol)!;
  const bracket = brackets.find(b => notional <= b.notionalCap) ?? brackets[brackets.length - 1];
  const exchangeMax = bracket?.initialLeverage ?? 1;
  return Math.min(leverage, exchangeMax);
}

/** Dry-run tanpa BINANCE_API_KEY sama sekali tetap bisa dites, pakai equity dummy (DRY_RUN_EQUITY, default 10000). */
async function currentEquity(): Promise<number> {
  if (EXEC_MODE !== "live" && !process.env.BINANCE_API_KEY) return Number(process.env.DRY_RUN_EQUITY ?? 10_000);
  const account = await getAccount();
  return account.totalMarginBalance;
}

let logCount = 0; // dipakai ringkasan per putaran: tidak ada baris log baru = tidak ada sinyal/kejadian
function log(line: string) {
  logCount++;
  const stamp = new Date().toISOString();
  const file = path.join(OFFICE_DIR, "execution", `log-${stamp.slice(0, 10)}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ t: stamp, msg: line }) + "\n");
  console.log(`[${stamp}] ${line}`);
  writeAgentStatus("executor", line);
}

// Riwayat equity untuk dashboard Trading Floor (office/execution/equity.jsonl).
// Hanya mencatat angka yang sudah diambil bot; maksimal 1 baris per menit. Gagal tulis tidak boleh mengganggu trading.
const EQUITY_FILE = path.join(OFFICE_DIR, "execution", "equity.jsonl");
let lastEquityAt = 0;
function recordEquity(equity: number) {
  if (!Number.isFinite(equity) || Date.now() - lastEquityAt < 60_000) return;
  lastEquityAt = Date.now();
  try {
    fs.mkdirSync(path.dirname(EQUITY_FILE), { recursive: true });
    fs.appendFileSync(EQUITY_FILE, JSON.stringify({ t: new Date().toISOString(), equity, mode: EXEC_MODE }) + "\n");
  } catch { /* abaikan */ }
}

// Deposit/penarikan (office/execution/transfers.jsonl), supaya dashboard & laporan tidak menghitungnya sebagai untung/rugi.
// Sumber: riwayat income Binance (GET, read-only). Risk Engine sendiri sudah memakai PnL dari income (lihat dailyPnl).
const TRANSFERS_FILE = path.join(OFFICE_DIR, "execution", "transfers.jsonl");
const TRANSFER_TYPES = new Set(["TRANSFER", "INTERNAL_TRANSFER"]);
const TRANSFER_ASSETS = new Set(["USDT", "USDC"]);
async function syncTransfers() {
  if (EXEC_MODE !== "live") return;
  let since = 0;
  const seen = new Set<string>();
  try {
    for (const l of fs.readFileSync(TRANSFERS_FILE, "utf8").split("\n")) {
      try { const j = JSON.parse(l) as { t: string; id?: string }; since = Math.max(since, Date.parse(j.t)); if (j.id) seen.add(j.id); } catch { /* baris kosong */ }
    }
  } catch { /* belum ada file: mulai dari titik equity pertama (maks 30 hari) */ }
  if (!since) {
    let first = Date.now() - 30 * 86_400_000;
    try { const l = fs.readFileSync(EQUITY_FILE, "utf8").split("\n")[0]; if (l) first = Math.max(first, Date.parse((JSON.parse(l) as { t: string }).t) - 3_600_000); } catch { /* tidak ada equity */ }
    since = first;
  }
  const income = await getIncomeAll(since);
  const fresh = income.filter(i => TRANSFER_TYPES.has(i.incomeType) && (!i.asset || TRANSFER_ASSETS.has(i.asset)) && i.income !== 0)
    .filter(i => { const id = i.tranId ?? `${i.time}|${i.income}`; if (seen.has(id)) return false; seen.add(id); return true; });
  for (const i of fresh) {
    const rec = { t: new Date(i.time).toISOString(), amount: i.income, type: i.incomeType, asset: i.asset ?? "USDT", id: i.tranId ?? `${i.time}|${i.income}` };
    fs.mkdirSync(path.dirname(TRANSFERS_FILE), { recursive: true });
    fs.appendFileSync(TRANSFERS_FILE, JSON.stringify(rec) + "\n");
    log(`Transfer ${i.income > 0 ? "masuk" : "keluar"} ${i.income > 0 ? "+" : "−"}$${Math.abs(i.income).toFixed(2)} (${i.incomeType}) — dicatat terpisah, bukan untung/rugi trading`);
  }
}

// Jurnal trade untuk dashboard (office/execution/trades.jsonl): satu baris per posisi yang tertutup.
// LIVE: harga exit, PnL, fee dari riwayat fill Binance (GET, read-only). DRY_RUN: estimasi dari harga close bar.
// Kalau pencatatan gagal, trading tetap jalan; hanya baris jurnal itu yang hilang.
const TRADES_FILE = path.join(OFFICE_DIR, "execution", "trades.jsonl");
async function journalTrade(entry: WatchlistEntry, pos: BotPosition, reason: string, refPrice: number) {
  const key = `${entry.symbol} ${entry.tf} ${entry.strategyId}`;
  try {
    const dir = pos.side === "long" ? 1 : -1;
    let exit = refPrice;
    let gross = (refPrice - pos.entry) * pos.qty * dir;
    let fees = 0, funding = 0;
    let source = "estimasi close bar";
    if (EXEC_MODE === "live") {
      const since = (pos.openedAt ?? pos.entryTime) - 60_000;
      await sleep(500);
      const trades = await getUserTrades(entry.symbol, since);
      const opp = pos.side === "long" ? "SELL" : "BUY";
      const exits = trades.filter(t => t.side === opp);
      const q = exits.reduce((s, t) => s + t.qty, 0);
      if (q > 0) {
        exit = exits.reduce((s, t) => s + t.price * t.qty, 0) / q;
        gross = trades.reduce((s, t) => s + t.realizedPnl, 0);
        fees = -trades.filter(t => t.commissionAsset === "USDT").reduce((s, t) => s + t.commission, 0);
        source = "fill Binance";
      }
      funding = (await getIncome(entry.symbol, since, "FUNDING_FEE")).reduce((s, i) => s + i.income, 0);
    }
    const pnl = gross + fees + funding;
    const r = pos.riskUsd > 0 ? pnl / pos.riskUsd : 0;
    const now = Date.now();
    const rec = {
      t: new Date(now).toISOString(), mode: EXEC_MODE, symbol: entry.symbol, tf: entry.tf, strategyId: entry.strategyId,
      side: pos.side, entry: pos.entry, exit, qty: pos.qty, initialStop: pos.initialStop, target: pos.target ?? null,
      riskUsd: pos.riskUsd, grossPnl: gross, fees, funding, pnl, r, reason, source,
      openedAt: pos.openedAt ?? pos.entryTime, closedAt: now, crowd: pos.crowd ?? null,
    };
    fs.mkdirSync(path.dirname(TRADES_FILE), { recursive: true });
    fs.appendFileSync(TRADES_FILE, JSON.stringify(rec) + "\n");
    log(`${key}: jurnal — ${pos.side} ${pos.entry} → ${Number(exit.toPrecision(8))}, PnL ${pnl >= 0 ? "+" : "-"}$${Math.abs(pnl).toFixed(2)} (${r >= 0 ? "+" : ""}${r.toFixed(2)}R, ${reason})`);
  } catch (e) {
    log(`${key}: jurnal trade tidak tercatat (${(e as Error).message}). Trading tidak terpengaruh.`);
  }
}

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, Math.max(ms, 0)));
}

function nextBoundary(tf: Timeframe): number {
  const step = TF_MS[tf];
  return Math.ceil((Date.now() + 5_000) / step) * step;
}

async function openPosition(entry: WatchlistEntry, intent: { side: "long" | "short"; stop: number; target?: number; reason: string }, decision: { qty: number; leverage: number; riskUsd: number }, barTime: number, refPrice: number): Promise<BotPosition> {
  if (EXEC_MODE !== "live") {
    log(`${entry.symbol} ${entry.tf} ${entry.strategyId}: DRY RUN — akan buka ${intent.side} qty ${decision.qty.toFixed(6)} stop ${intent.stop}` + (intent.target !== undefined ? ` target ${intent.target}` : ""));
    return { side: intent.side, entry: refPrice, qty: decision.qty, stop: intent.stop, initialStop: intent.stop, target: intent.target, leverage: decision.leverage, entryTime: barTime, riskUsd: decision.riskUsd, reason: intent.reason, openedAt: Date.now() };
  }

  const key = `${entry.symbol} ${entry.tf} ${entry.strategyId}`;
  // Semua yang bisa gagal dihitung SEBELUM order entry dikirim, supaya tidak ada yang bisa throw di antara
  // fill dan pemasangan stop loss.
  const f = await filtersOf(entry.symbol);
  const qty = floorToStep(decision.qty, f.stepSize);
  if (!(qty > 0)) throw new Error(`qty ${decision.qty} lebih kecil dari stepSize ${f.stepSize}, entry dilewati`);
  const stopPrice = roundToTick(intent.stop, f.tickSize);
  const targetPrice = intent.target !== undefined ? roundToTick(intent.target, f.tickSize) : undefined;
  const leverage = await clampToExchangeLeverage(entry.symbol, decision.leverage, qty * refPrice);
  if (leverage < decision.leverage) log(`${key}: leverage diturunkan dari ${decision.leverage}x ke ${leverage}x sesuai batas asli exchange untuk notional ini`);
  await setLeverage(entry.symbol, leverage);
  const side = intent.side === "long" ? "BUY" : "SELL";
  const opp = intent.side === "long" ? "SELL" : "BUY";
  const openedAt = Date.now();
  let orderId: number | string;
  try {
    orderId = (await newOrder({ symbol: entry.symbol, side, type: "MARKET", quantity: qty })).orderId;
  } catch (e) {
    if (!(e instanceof BinanceUnknownResult)) throw e; // ditolak Binance (4xx): pasti tidak ada posisi baru
    // Timeout/5xx: order MUNGKIN sudah terisi. Jangan anggap gagal begitu saja, atau posisi tertinggal tanpa stop.
    log(`${key}: jawaban order entry tidak jelas (${e.message}) — mengecek posisi di exchange...`);
    await sleep(2_000);
    const live = await getPositionRisk(entry.symbol).catch(() => undefined);
    if (live === undefined) {
      log(`${key}: KRITIS — status entry tidak diketahui dan posisi tidak bisa dicek. Watchdog mengecek lagi tiap menit; cek manual di Binance.`);
      throw e;
    }
    if (!live || Math.sign(live.positionAmt) !== (intent.side === "long" ? 1 : -1)) throw new Error(`order entry tidak tereksekusi (${e.message})`);
    log(`${key}: posisi ternyata terbuka (${live.positionAmt}) — lanjut pasang stop loss`);
    orderId = "?";
  }

  // Mulai titik ini posisi SUDAH terbuka: harga fill cuma informasi, gagal dibaca tidak boleh menggagalkan stop.
  let fillPrice = refPrice;
  try {
    await sleep(500);
    fillPrice = (await getPositionRisk(entry.symbol))?.entryPrice ?? refPrice;
  } catch { /* pakai harga close bar sebagai perkiraan */ }
  log(`${key}: LIVE entry ${intent.side} qty ${qty} @ ${fillPrice} (order ${orderId})`);

  let stopOrderId: number | undefined;
  try {
    stopOrderId = await placeProtectiveOrder(entry.symbol, opp, "STOP_MARKET", stopPrice);
  } catch (e) {
    log(`${key}: GAGAL pasang stop loss setelah entry — ${(e as Error).message}. Menutup posisi darurat (tidak boleh ada posisi tanpa stop).`);
    await emergencyClose(entry, key);
    throw new Error(`Entry ${key} dibatalkan: gagal pasang stop loss (${(e as Error).message})`);
  }

  // Target opsional: posisi sudah terlindungi stop, jadi gagal pasang target tidak membatalkan entry.
  let targetOrderId: number | undefined;
  if (targetPrice !== undefined) {
    try {
      targetOrderId = await placeProtectiveOrder(entry.symbol, opp, "TAKE_PROFIT_MARKET", targetPrice);
    } catch (e) {
      log(`${key}: PERINGATAN — take profit gagal dipasang (${(e as Error).message}). Posisi tetap dilindungi stop loss.`);
    }
  }
  log(`${key}: stop loss terpasang di exchange (algo ${stopOrderId})` + (targetOrderId ? `, take profit (algo ${targetOrderId})` : ""));
  return {
    side: intent.side, entry: fillPrice, qty, stop: intent.stop, initialStop: intent.stop, target: intent.target,
    leverage, entryTime: barTime, riskUsd: decision.riskUsd, reason: intent.reason, openedAt, stopOrderId, targetOrderId,
  };
}

async function emergencyClose(entry: WatchlistEntry, key: string) {
  try {
    await closePositionMarket(entry.symbol);
    await cancelAllAlgoOpenOrders(entry.symbol).catch(() => {});
    log(`${key}: posisi darurat berhasil ditutup.`);
  } catch (closeErr) {
    log(`${key}: KRITIS — gagal menutup posisi darurat (${(closeErr as Error).message}). POSISI TERBUKA TANPA STOP DI EXCHANGE — cek manual SEKARANG lewat Binance.`);
  }
}

/** ok = stop baru aktif (atau dry run). failed = gagal, stop lama tetap berlaku.
 * crossed = harga sudah melewati stop baru (Binance -2021), jadi posisi harus ditutup sekarang. */
async function updateStop(entry: WatchlistEntry, pos: BotPosition, newStop: number): Promise<"ok" | "failed" | "crossed"> {
  const key = `${entry.symbol} ${entry.tf} ${entry.strategyId}`;
  const stopPrice = roundToTick(newStop, (await filtersOf(entry.symbol)).tickSize);
  if (EXEC_MODE !== "live") { log(`${key}: DRY RUN — akan ketatkan stop ke ${stopPrice}`); return "ok"; }
  const opp = pos.side === "long" ? "SELL" : "BUY";
  const oldId = pos.stopOrderId;
  // Pasang stop baru dulu, baru cabut yang lama — posisi tidak pernah sedetik pun tanpa stop.
  try {
    pos.stopOrderId = await placeProtectiveOrder(entry.symbol, opp, "STOP_MARKET", stopPrice);
  } catch (e) {
    if (/-2021/.test((e as Error).message)) return "crossed";
    log(`${key}: stop baru ${stopPrice} gagal dipasang (${(e as Error).message}) — stop lama tetap aktif.`);
    return "failed";
  }
  if (oldId) await cancelAlgoOrder(oldId).catch(e => log(`${key}: stop lama (algo ${oldId}) gagal dibatalkan: ${(e as Error).message}`));
  log(`${key}: LIVE stop diketatkan ke ${stopPrice}`);
  return "ok";
}

async function closePosition(entry: WatchlistEntry, pos: BotPosition, reason: string) {
  const key = `${entry.symbol} ${entry.tf} ${entry.strategyId}`;
  if (EXEC_MODE !== "live") { log(`${key}: DRY RUN — akan tutup posisi (${reason})`); return; }
  // Tutup dulu; stop/target baru dicabut SETELAH posisi benar-benar tertutup. Kalau tutup gagal, throw → stop lama tetap menjaga.
  await closePositionMarket(entry.symbol);
  await cancelAllAlgoOpenOrders(entry.symbol).catch(e => log(`${key}: order stop/target sisa gagal dibatalkan: ${(e as Error).message}`));
  log(`${key}: LIVE tutup posisi (${reason})`);
}

/** Posisi yang dicatat bot sudah tidak ada di exchange (SL/TP ter-trigger): bersihkan order sisa dan catat jurnal. */
async function syncClosed(entry: WatchlistEntry, st: WatchState, refPrice: number) {
  const key = `${entry.symbol} ${entry.tf} ${entry.strategyId}`;
  log(`${key}: posisi sudah tertutup di exchange (SL/TP ter-trigger) — sinkronkan state`);
  // Sisi lain (TP kalau SL yang kena, atau sebaliknya) masih menggantung sebagai algo order; bersihkan.
  await cancelAllAlgoOpenOrders(entry.symbol).catch(e => log(`${key}: order stop/target sisa gagal dibatalkan: ${(e as Error).message}`));
  const closed = st.position!;
  st.position = null;
  await journalTrade(entry, closed, "SL/TP di exchange", refPrice);
}

// Watchdog tiap menit (LIVE): bar 4h terlalu jarang untuk satu-satunya pemeriksaan. Tiap menit cek
// (1) posisi bot yang sudah tertutup di exchange, (2) posisi di exchange yang tidak dicatat bot,
// (3) posisi bot yang stop loss-nya hilang dari exchange -> pasang ulang, atau tutup kalau harga sudah lewat stop.
const alerted = new Set<string>(); // peringatan sekali per kejadian, bukan tiap menit
const stopMissing = new Map<string, number>();
let watchdogErrAt = 0;
function alertOnce(id: string, line: string) { if (!alerted.has(id)) { alerted.add(id); log(line); } }
function watchdogError(e: unknown) {
  if (Date.now() - watchdogErrAt < 30 * 60_000) return;
  watchdogErrAt = Date.now();
  log(`Watchdog posisi: tidak bisa cek Binance (${(e as Error).message}). Dicoba lagi tiap menit.`);
}

async function watchdog(watchlist: WatchlistEntry[], state: BotState) {
  if (EXEC_MODE !== "live") return;
  let positions: Awaited<ReturnType<typeof getAllPositions>>;
  try { positions = await getAllPositions(); } catch (e) { watchdogError(e); return; }
  for (const entry of watchlist) {
    const key = watchKey(entry.symbol, entry.tf, entry.strategyId);
    const label = `${entry.symbol} ${entry.tf} ${entry.strategyId}`;
    const st = state[key];
    const live = positions.get(entry.symbol);
    try {
      if (!live) alerted.delete(`${key}|untracked`);
      if (st?.position && !live) { stopMissing.delete(key); await syncClosed(entry, st, st.position.stop); continue; }
      if (!st?.position && live) {
        alertOnce(`${key}|untracked`, `${label}: KRITIS — ada posisi ${live.positionAmt} @ ${live.entryPrice} di exchange yang TIDAK dicatat bot (entry manual, atau entry yang terputus). Bot tidak menyentuhnya dan tidak entry baru di simbol ini. Pastikan ada stop loss — cek di Binance.`);
        continue;
      }
      if (!st?.position || !live) continue;

      const opp = st.position.side === "long" ? "SELL" : "BUY";
      const orders = await getOpenAlgoOrders(entry.symbol);
      if (orders.some(o => o.type === "STOP_MARKET" && o.side === opp)) { stopMissing.delete(key); alerted.delete(`${key}|nostop`); continue; }
      // Harus hilang 2 cek berturut-turut: saat stop sedang ter-trigger, order-nya sudah lepas tapi posisi belum nol.
      const misses = (stopMissing.get(key) ?? 0) + 1;
      stopMissing.set(key, misses);
      if (misses < 2) continue;
      await restoreStop(entry, st, label);
    } catch (e) { watchdogError(e); }
  }
}

async function restoreStop(entry: WatchlistEntry, st: WatchState, label: string) {
  const pos = st.position!;
  const key = watchKey(entry.symbol, entry.tf, entry.strategyId);
  const opp = pos.side === "long" ? "SELL" : "BUY";
  try {
    const stopPrice = roundToTick(pos.stop, (await filtersOf(entry.symbol)).tickSize);
    pos.stopOrderId = await placeProtectiveOrder(entry.symbol, opp, "STOP_MARKET", stopPrice);
    stopMissing.delete(key);
    log(`${label}: KRITIS — stop loss tidak ditemukan di exchange, sudah DIPASANG ULANG di ${stopPrice} (algo ${pos.stopOrderId}).`);
  } catch (e) {
    const msg = (e as Error).message;
    if (/-4130/.test(msg)) { stopMissing.delete(key); return; } // Binance: stop closePosition di arah ini sudah ada
    if (/-2021/.test(msg)) {
      log(`${label}: stop loss hilang dan harga sudah melewati ${pos.stop} — tutup posisi sekarang.`);
      await closePosition(entry, pos, "stop terlewati (watchdog)");
      st.position = null;
      stopMissing.delete(key);
      await journalTrade(entry, pos, "stop terlewati (watchdog)", pos.stop);
      return;
    }
    alertOnce(`${key}|nostop`, `${label}: KRITIS — stop loss tidak ada di exchange dan gagal dipasang ulang (${msg}). Pasang stop manual di Binance SEKARANG.`);
  }
}

const PNL_INCOME = new Set(["REALIZED_PNL", "COMMISSION", "FUNDING_FEE"]);
/** Reset batas rugi harian oleh Bos (`npm run bot:reset-day` menulis waktu ISO ke execution/DAY_RESET): PnL harian
 * dihitung mulai saat itu. Hanya berlaku di hari WIB yang sama; besok otomatis kembali normal. */
const DAY_RESET_FILE = path.join(OFFICE_DIR, "execution", "DAY_RESET");
function pnlSince(dayStartMs: number): number {
  try {
    const t = Date.parse(fs.readFileSync(DAY_RESET_FILE, "utf8").trim());
    if (Number.isFinite(t) && t > dayStartMs && t <= Date.now()) return t;
  } catch { /* tidak ada reset */ }
  return dayStartMs;
}
/** PnL hari ini (WIB) = realized + fee + funding sejak 00:00 WIB + unrealized. Deposit/withdraw tidak ikut terhitung.
 * Basis persen = equity sekarang dikurangi PnL hari ini. Kalau Binance gagal, pakai cara lama (selisih equity). */
async function dailyPnl(equity: number, dayKey: number, st: WatchState): Promise<{ dayPnl: number; dayStartEquity: number }> {
  if (EXEC_MODE === "live") {
    try {
      const income = await getIncomeAll(pnlSince(dayKey * 86_400_000 - DAY_OFFSET));
      const realized = income.filter(i => PNL_INCOME.has(i.incomeType)).reduce((s, i) => s + i.income, 0);
      const dayPnl = realized + (await getAccount()).totalUnrealizedProfit;
      if (Number.isFinite(dayPnl)) return { dayPnl, dayStartEquity: equity - dayPnl };
    } catch (e) {
      log(`PnL harian dari riwayat Binance tidak bisa diambil (${(e as Error).message}); pakai selisih equity.`);
    }
  }
  return { dayPnl: equity - st.dayStartEquity, dayStartEquity: st.dayStartEquity };
}

/** Setelan strategi untuk sinyal baru: default, ditimpa hasil penyetelan 90 harian (execution/params.json), ditimpa
 * `params` di baris watchlist kalau Bos mengisinya manual. */
function strategyParams(entry: WatchlistEntry): Params {
  const def = getStrategy(entry.strategyId);
  return { ...def.defaults, ...tunedParams(entry), ...(entry.params ?? {}) };
}

/** Cek approval yang masih pending TANPA nunggu — dipanggil dari loop cepat (tiap ~1 menit) supaya kamu
 * approve/reject lewat CLI terasa cepat, tidak harus nunggu bar close (bisa berjam-jam untuk TF 4h). */
async function resolvePendingApproval(entry: WatchlistEntry, st: WatchState): Promise<void> {
  const p = st.pendingApproval;
  if (!p) return;
  const key = watchKey(entry.symbol, entry.tf, entry.strategyId);
  const outcome = checkStatus(p.id, APPROVAL_TIMEOUT_MS);
  if (outcome === "pending") return;
  st.pendingApproval = undefined;
  if (outcome === "approved") {
    log(`${key}: approval disetujui (${p.id}) — lanjut entry`);
    st.position = await openPosition(entry,
      { side: p.side, stop: p.stop, target: p.target, reason: p.reason },
      { qty: p.qty, leverage: p.leverage, riskUsd: p.riskUsd }, p.barTime, p.refPrice);
    st.position.params = strategyParams(entry);
    const crowd = crowdContext(entry.symbol, p.side);
    if (crowd) st.position.crowd = crowd.text;
  } else {
    log(`${key}: approval ${outcome} (${p.id}) — entry dilewati`);
  }
}

/** false = belum ada bar close baru untuk entry ini (tidak dihitung sebagai "dicek"). */
async function tick(entry: WatchlistEntry, state: BotState): Promise<boolean> {
  const key = watchKey(entry.symbol, entry.tf, entry.strategyId);
  const st = state[key] ?? { position: null, lastBarTime: 0, dayKey: -1, dayStartEquity: 0 };
  state[key] = st;

  const def = getStrategy(entry.strategyId);
  // Posisi terbuka memakai setelan saat entry; sinyal baru memakai setelan terbaru (default < hasil penyetelan < params baris).
  const params = st.position?.params ?? strategyParams(entry);
  const strat = def.create(params);
  const lookbackBars = Math.max(strat.warmup + 50, 600);
  const from = Date.now() - lookbackBars * TF_MS[entry.tf];
  const candles = await fetchKlines(entry.symbol, entry.tf, from);
  if (candles.length < strat.warmup + 2) { log(`${key}: data kurang (${candles.length} bar), lewati tick`); return true; }

  strat.prepare(candles);
  const i = candles.length - 1;
  const bar = candles[i]!;
  if (bar.t === st.lastBarTime) return false; // belum ada bar close baru
  st.lastBarTime = bar.t;

  const dk = Math.floor((bar.t + DAY_OFFSET) / 86_400_000);
  const equity = await currentEquity();
  recordEquity(equity);
  if (dk !== st.dayKey) { st.dayKey = dk; st.dayStartEquity = equity; }

  // Rekonsiliasi: kalau SL/TP sudah ter-trigger di exchange sejak tick terakhir, state kita jadi basi.
  // Tanpa ini, bot bisa "nyangkut" mengira posisi masih terbuka selamanya dan tidak pernah entry baru lagi.
  if (EXEC_MODE === "live") {
    const live = await getPositionRisk(entry.symbol);
    if (st.position && !live) {
      await syncClosed(entry, st, bar.c);
    } else if (!st.position && live) {
      // Ada posisi di exchange yang tidak dicatat bot (entry manual, atau entry yang gagal di tengah jalan).
      // Bot tidak tahu stop-nya, jadi jangan menumpuk entry baru di atasnya.
      log(`${key}: KRITIS — ada posisi ${live.positionAmt} @ ${live.entryPrice} di exchange yang TIDAK dicatat bot. Sinyal baru simbol ini dilewati. Cek manual di Binance.`);
      return true;
    }
  }

  if (st.position) {
    const entryIdx = candles.findIndex(c => c.t === st.position!.entryTime);
    if (entryIdx === -1) { log(`${key}: bar entry sudah di luar jendela data, lewati manage() tick ini`); return true; }
    const pos = { ...st.position, entryIndex: entryIdx, margin: 0, liq: 0, fees: 0, funding: 0 } as unknown as Position;
    const m = strat.manage(i, pos);
    let exitReason = m?.exit ? (m.reason ?? "signal") : null;
    if (m?.newStop !== undefined && Number.isFinite(m.newStop) && m.newStop !== st.position.stop) {
      const r = await updateStop(entry, st.position, m.newStop);
      if (r === "ok") st.position.stop = m.newStop;
      else if (r === "crossed") exitReason ??= `harga sudah melewati stop baru ${m.newStop}`;
    }
    if (exitReason) {
      await closePosition(entry, st.position, exitReason);
      const closed = st.position;
      st.position = null;
      await journalTrade(entry, closed, exitReason, bar.c);
    }
  } else if (st.pendingApproval) {
    await resolvePendingApproval(entry, st);
  } else {
    const intent = strat.signal(i);
    const news = intent && NEWS_BLACKOUT_MS > 0 ? activeBlackout(NEWS_BLACKOUT_MS) : null;
    if (intent && isStaleSignal(bar.t, entry.tf)) {
      log(`${key}: sinyal ${intent.side} dilewati — basi: candle selesai ${Math.round(signalAgeMs(bar.t, entry.tf) / 60_000)} menit lalu (bot baru menyala atau terlambat). Entry hanya dari candle yang selesai ≤ ${MAX_SIGNAL_AGE_MS / 60_000} menit.`);
    } else if (intent && news) {
      const at = new Date(Date.parse(news.at) + DAY_OFFSET).toISOString().slice(11, 16);
      log(`${key}: sinyal ${intent.side} ditolak — jendela berita ${news.country} ${news.title} (${at} WIB, ${news.minutes >= 0 ? `${news.minutes} menit lagi` : `${-news.minutes} menit lalu`})`);
    } else if (intent) {
      // maxOpenPositions berlaku PER TIMEFRAME (mis. 2 posisi 4h + 2 posisi 1h). Kunci state: SYMBOL_tf_strategi.
      const openPositions = Object.entries(state).filter(([k, s]) => s.position && k.split("_")[1] === entry.tf).length;
      const day = await dailyPnl(equity, dk, st);
      const decision = evaluateRisk({
        intent, refPrice: bar.c, equity, dayStartEquity: day.dayStartEquity, dayPnl: day.dayPnl,
        openPositions, spec: marketSpec(entry.symbol), trailingExit: strat.trailing, rules: rulesFor(entry),
      });
      const crowd = decision.ok ? crowdContext(entry.symbol, intent.side) : null;
      if (decision.ok && crowd) log(`${key}: konteks crowd — ${crowd.text}`);
      if (decision.ok && CROWD_FILTER && crowd?.againstCrowd) {
        log(`${key}: sinyal ${intent.side} ditolak — filter crowd: pasar ${crowd.flag} (CROWD_FILTER=true)`);
      } else if (decision.ok) {
        log(`${key}: sinyal ${intent.side} diterima Risk Engine — qty ${decision.qty.toFixed(6)}, leverage ${decision.leverage}x, risk $${decision.riskUsd.toFixed(2)} (${intent.reason})`);
        if (!REQUIRE_APPROVAL) {
          log(`${key}: REQUIRE_APPROVAL=false — entry otomatis tanpa approval manusia`);
          st.position = await openPosition(entry, intent, decision, bar.t, bar.c);
          st.position.params = params;
          if (crowd) st.position.crowd = crowd.text;
        } else {
          const approval = createApproval({
            symbol: entry.symbol, tf: entry.tf, strategyId: entry.strategyId, side: intent.side,
            qty: decision.qty, stop: intent.stop, target: intent.target, leverage: decision.leverage,
            riskUsd: decision.riskUsd, reason: intent.reason,
          });
          st.pendingApproval = {
            id: approval.id, side: intent.side, stop: intent.stop, target: intent.target, reason: intent.reason,
            qty: decision.qty, leverage: decision.leverage, riskUsd: decision.riskUsd, barTime: bar.t, refPrice: bar.c,
          };
          log(`${key}: menunggu approval manusia (${approval.id}) — tidak menahan simbol lain, dicek lagi tick berikutnya`);
        }
      } else {
        log(`${key}: sinyal ${intent.side} ditolak — ${decision.rejections.map(r => REJECTION_LABEL[r] ?? r).join("; ")}`);
      }
    }
  }
  return true;
}

const wibHm = (t: number) => new Date(t + DAY_OFFSET).toISOString().slice(11, 16);

async function main() {
  const watchlist = loadWatchlist();
  if (!watchlist.length) {
    const example = writeWatchlistTemplate();
    console.log(`Watchlist kosong. Isi ${watchlistPath()} (array {symbol, tf, strategyId}) sebelum menjalankan bot.`);
    console.log(`Contoh isinya sudah dibuat di ${example} — salin ke watchlist.json dan sesuaikan.`);
    return;
  }
  const dupSymbols = watchlist.map(w => w.symbol).filter((s, i, a) => a.indexOf(s) !== i);
  if (dupSymbols.length) {
    console.log(`Watchlist tidak valid: simbol ${[...new Set(dupSymbols)].join(", ")} muncul lebih dari sekali.`);
    console.log(`Order SL/TP di bot ini pakai closePosition:true (menutup SELURUH posisi simbol itu) — dua strategi berbagi satu simbol akan saling tabrak order satu sama lain. Pisahkan ke simbol berbeda, atau jalankan sebagai dua bot/env terpisah.`);
    return;
  }

  log(`Bot dimulai. Mode: ${EXEC_MODE.toUpperCase()}. Watchlist: ${watchlist.map(w => `${w.symbol} ${w.tf} ${w.strategyId}`).join(", ")}`);
  log(REQUIRE_APPROVAL
    ? `Setiap entry baru butuh approval manusia (timeout ${APPROVAL_TIMEOUT_MS / 60_000} menit) — lihat office/approvals/. Exit (SL/TP) tetap otomatis karena sudah order asli di exchange.`
    : `REQUIRE_APPROVAL=false — entry baru LANGSUNG OTOMATIS tanpa approval manusia. Exit (SL/TP) tetap otomatis seperti biasa.`);
  syncTransfers().catch(() => { /* riwayat transfer opsional; dicoba lagi di snapshot equity berikutnya */ });
  if (EXEC_MODE === "live") {
    try {
      if (await isHedgeMode()) {
        log("Bot tidak dijalankan: akun Binance Futures dalam Hedge Mode, bot ini hanya mendukung One-way Mode. Ubah di Binance Futures > Preferences > Position Mode > One-way, lalu jalankan lagi.");
        return;
      }
    } catch (e) { log(`Mode posisi akun tidak bisa dicek (${(e as Error).message}); lanjut dengan asumsi One-way Mode.`); }
  }
  if (EXEC_MODE !== "live") log("DRY RUN — approval disetujui pun cuma dicatat, tidak ada order asli yang dikirim. Set EXEC_MODE=live untuk eksekusi sungguhan.");

  for (;;) {
    if (fs.existsSync(STOP_FILE)) { log("Kill switch terdeteksi (office/execution/STOP). Bot berhenti. Posisi+SL/TP yang sudah terpasang di exchange tetap aktif."); return; }
    const tfs = [...new Set(watchlist.map(w => w.tf))];
    const nextBar = Math.min(...tfs.map(nextBoundary)) + 30_000;

    // Sambil nunggu bar close, cek approval pending tiap ~1 menit — supaya approve/reject lewat CLI
    // terasa cepat, tidak harus nunggu bar close (bisa berjam-jam untuk TF 4h).
    while (Date.now() < nextBar) {
      if (fs.existsSync(STOP_FILE)) { log("Kill switch terdeteksi. Bot berhenti."); return; }
      const state = loadState();
      for (const entry of watchlist) {
        const key = watchKey(entry.symbol, entry.tf, entry.strategyId);
        const st = state[key];
        if (!st?.pendingApproval) continue;
        try { await resolvePendingApproval(entry, st); }
        catch (e) { log(`${entry.symbol} ${entry.tf} ${entry.strategyId}: ERROR cek approval — ${(e as Error).message}`); }
      }
      await watchdog(watchlist, state);
      saveState(state);
      if (EQUITY_SNAPSHOT_MS > 0 && Date.now() - lastEquityAt >= EQUITY_SNAPSHOT_MS) {
        try { recordEquity(await currentEquity()); } catch { /* snapshot dashboard opsional, jangan ganggu loop */ }
        try { await syncTransfers(); } catch { /* opsional, dicoba lagi di snapshot berikutnya */ }
      }
      await sleep(Math.min(60_000, Math.max(nextBar - Date.now(), 0)));
    }
    if (fs.existsSync(STOP_FILE)) { log("Kill switch terdeteksi. Bot berhenti."); return; }

    const state = loadState();
    const logsBefore = logCount;
    let checked = 0;
    const checkedTf: Record<string, number> = {};
    const boundary = nextBar - 30_000;
    // Candle yang baru close kadang belum muncul di API 30 detik setelahnya. Yang jatuh tempo tapi belum ada
    // dicoba lagi (maks 3x, jeda 20 detik) supaya sinyal candle ini tidak terlewat sampai candle berikutnya.
    let todo = watchlist;
    for (let attempt = 0; attempt < 4 && todo.length; attempt++) {
      if (attempt > 0) await sleep(20_000);
      const late: WatchlistEntry[] = [];
      for (const entry of todo) {
        try {
          if (await tick(entry, state)) { checked++; checkedTf[entry.tf] = (checkedTf[entry.tf] ?? 0) + 1; }
          else if (boundary % TF_MS[entry.tf] === 0) late.push(entry);
        } catch (e) { checked++; checkedTf[entry.tf] = (checkedTf[entry.tf] ?? 0) + 1; log(`${entry.symbol} ${entry.tf} ${entry.strategyId}: ERROR — ${(e as Error).message}`); }
        saveState(state); // per simbol: posisi yang baru dibuka langsung tercatat walau bot crash di simbol berikutnya
      }
      todo = late;
    }
    if (todo.length) log(`Candle ${wibHm(boundary)} WIB belum tersedia dari Binance untuk ${todo.map(e => e.symbol).join(", ")}; dicek lagi di candle berikutnya.`);
    // Ringkasan supaya log kantor & Telegram tetap menunjukkan bot bekerja walau tidak ada sinyal berjam-jam.
    if (checked > 0) {
      const open = Object.values(state).filter(s => s.position).length;
      const quiet = logCount === logsBefore;
      const next = Math.min(...tfs.map(nextBoundary)) + 30_000;
      // Rincian per timeframe, mis. "4h 12 koin + 1h 2 koin", supaya jelas cek 4h ikut jalan atau hanya 1h.
      const perTf = Object.entries(checkedTf).sort((a, b) => TF_MS[b[0] as Timeframe] - TF_MS[a[0] as Timeframe]).map(([tf, n]) => `${tf} ${n} koin`).join(" + ");
      log(`Cek sinyal ${wibHm(nextBar - 30_000)} WIB selesai: ${perTf || `${checked} koin`} dicek, ${quiet ? "tidak ada sinyal" : "ada kejadian (lihat baris di atas)"}. Posisi terbuka: ${open}. Cek berikutnya ${wibHm(next)} WIB.`);
    }
  }
}

main().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
