// Riset: sinyal 4h (strategi watchlist yang sudah terbukti) + entry lebih bagus di 15m.
// Untuk setiap trade backtest 4h biasa, versi "15m" TIDAK masuk di open bar 4h berikutnya, tapi memasang LIMIT
// di harga pullback (sebagian jarak ke stop) dan menunggu maksimal W jam di chart 15m.
//   - Terisi  → entry di harga limit (fee maker), stop & exit SAMA dengan trade 4h aslinya → R lebih besar.
//   - Tidak terisi sebelum waktunya habis / sebelum trade 4h selesai → trade dilewati (0R). Ini sengaja dihitung,
//     karena trade terbaik sering justru yang tidak sempat pullback.
// Pembanding yang adil: total R per tahun (tiap trade mempertaruhkan 1R yang sama), bukan cuma rata-rata.
// TIDAK mengirim order. Hasil ke office/scalp/mtf-<waktu>.json + .md.
//
//   npm run mtf:test     (otomatis ambil data 15m 365 hari untuk koin watchlist kalau belum ada)
import "dotenv/config";
import path from "node:path";
import type { Candle } from "../types.js";
import { TF_MS, marketSpec } from "../types.js";
import { fetchKlines } from "../data/binance.js";
import { candlePath, loadCandles, loadFunding, saveJson } from "../data/store.js";
import { loadWatchlist } from "../exec/watchlist.js";
import { getStrategy } from "../strategies/index.js";
import { runBacktest } from "../backtest/engine.js";
import { DEFAULT_RULES } from "../risk/engine.js";
import { writeJsonAtomic } from "../ops/common.js";
import { SCALP_DIR } from "./paths.js";

const DAYS = Number(process.env.MTF_DAYS ?? 365);
const PULLBACKS = [0.25, 0.5];   // bagian dari jarak entry→stop
const WINDOWS_H = [4, 12];       // lama menunggu pullback
const SLIP = 0.0002;

const load = (symbol: string, tf: "15m" | "4h"): Candle[] => { try { return loadCandles(symbol, tf); } catch { return []; } };

async function ensure15m(symbol: string): Promise<Candle[]> {
  const from = Date.now() - DAYS * 86_400_000;
  const old = load(symbol, "15m").filter(c => c.t >= from);
  const covers = old.length > 0 && old[0]!.t <= from + 2 * TF_MS["15m"];
  const start = covers ? old.at(-1)!.t + TF_MS["15m"] : from;
  if (Date.now() - start > 2 * TF_MS["15m"]) {
    process.stdout.write(`  ambil 15m ${symbol} ... `);
    const fresh = await fetchKlines(symbol, "15m", start);
    const all = [...new Map([...old, ...fresh].map(c => [c.t, c])).values()].sort((a, b) => a.t - b.t);
    saveJson(candlePath(symbol, "15m"), all);
    console.log(`${all.length} candle`);
    return all;
  }
  return old;
}

async function ensure4h(symbol: string): Promise<Candle[]> {
  const old = load(symbol, "4h");
  const from = old.length ? old.at(-1)!.t + TF_MS["4h"] : Date.now() - (DAYS + 400) * 86_400_000;
  if (Date.now() - from > 2 * TF_MS["4h"]) {
    const fresh = await fetchKlines(symbol, "4h", from);
    const all = [...new Map([...old, ...fresh].map(c => [c.t, c])).values()].sort((a, b) => a.t - b.t);
    saveJson(candlePath(symbol, "4h"), all);
    return all;
  }
  return old;
}

interface Variant { pullback: number; windowH: number; trades: number; filled: number; totalR: number; avgR: number; winRate: number }
export interface MtfRow { key: string; symbol: string; strategyId: string; baseTrades: number; baseTotalR: number; baseAvgR: number; baseWin: number; variants: Variant[]; best: Variant | null }

/** Indeks bar pertama dengan t >= x (binary search). */
function firstAtOrAfter(c: Candle[], x: number): number {
  let lo = 0, hi = c.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (c[m]!.t < x) lo = m + 1; else hi = m; }
  return lo;
}

async function main() {
  const watch = loadWatchlist().filter(w => w.tf === "4h");
  if (!watch.length) { console.log("Watchlist 4h kosong."); return; }
  console.log(`Uji sinyal 4h + entry 15m untuk ${watch.length} strategi watchlist, ${DAYS} hari terakhir.`);
  const rows: MtfRow[] = [];

  for (const w of watch) {
    const key = `${w.symbol} ${w.strategyId}`;
    let c4: Candle[], c15: Candle[];
    try { c4 = await ensure4h(w.symbol); c15 = await ensure15m(w.symbol); } catch (e) { console.log(`${key}: data gagal diambil (${(e as Error).message})`); continue; }
    if (c4.length < 300 || c15.length < 1000) { console.log(`${key}: data kurang, dilewati`); continue; }
    const spec = marketSpec(w.symbol);
    const def = getStrategy(w.strategyId);
    const params = { ...def.defaults, ...(w.params ?? {}) };
    const startIdx = firstAtOrAfter(c4, c15[0]!.t + TF_MS["4h"]);
    const base = runBacktest(c4, def.create(params), { symbol: w.symbol, tf: "4h", initialEquity: 10_000, rules: { ...DEFAULT_RULES, riskPct: 1 }, startIndex: startIdx }, loadFunding(w.symbol));
    // Stop & target asli tiap trade: panggil ulang sinyal di bar sebelum entry.
    const strat = def.create(params);
    strat.prepare(c4);

    type T = { side: 1 | -1; entryT: number; exitT: number; entry: number; exit: number; stop: number; exitMaker: boolean };
    const trades: T[] = [];
    for (const t of base.trades) {
      const i = firstAtOrAfter(c4, t.entryTime) - 1;
      const intent = i >= 0 ? strat.signal(i) : null;
      if (!intent) continue;
      trades.push({ side: t.side === "long" ? 1 : -1, entryT: t.entryTime, exitT: t.exitTime, entry: t.entry, exit: t.exit, stop: intent.stop, exitMaker: t.exitReason === "target" });
    }
    if (!trades.length) { console.log(`${key}: tidak ada trade di rentang 15m`); continue; }

    // R bersih per trade dengan definisi yang sama untuk kedua versi.
    const rOf = (side: 1 | -1, entry: number, exit: number, stop: number, entryFee: number, exitFee: number) => {
      const risk = Math.abs(entry - stop);
      if (!(risk > 0)) return 0;
      return ((exit - entry) * side - entry * entryFee - exit * exitFee) / risk;
    };
    const baseR = trades.map(t => rOf(t.side, t.entry, t.exit, t.stop, spec.takerFee, t.exitMaker ? spec.makerFee : spec.takerFee));
    const stat = (rs: number[]) => ({ total: rs.reduce((a, b) => a + b, 0), avg: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 0, win: rs.length ? (rs.filter(r => r > 0).length / rs.length) * 100 : 0 });
    const b = stat(baseR);

    const variants: Variant[] = [];
    for (const pb of PULLBACKS) for (const wh of WINDOWS_H) {
      const rs: number[] = [];
      let filled = 0;
      for (const t of trades) {
        const limit = t.entry - t.side * pb * Math.abs(t.entry - t.stop);
        const until = Math.min(t.entryT + wh * 3_600_000, t.exitT);
        let hit = false;
        for (let k = firstAtOrAfter(c15, t.entryT); k < c15.length && c15[k]!.t < until; k++) {
          const bar = c15[k]!;
          if (t.side === 1 ? bar.l <= limit : bar.h >= limit) { hit = true; break; }
        }
        if (!hit) continue; // dilewati = 0R, tidak dihitung sebagai trade
        filled++;
        rs.push(rOf(t.side, limit, t.exit, t.stop, spec.makerFee, t.exitMaker ? spec.makerFee : spec.takerFee));
      }
      const s = stat(rs);
      variants.push({ pullback: pb, windowH: wh, trades: trades.length, filled, totalR: s.total, avgR: s.avg, winRate: s.win });
    }
    const best = [...variants].sort((x, y) => y.totalR - x.totalR)[0] ?? null;
    rows.push({ key, symbol: w.symbol, strategyId: w.strategyId, baseTrades: trades.length, baseTotalR: b.total, baseAvgR: b.avg, baseWin: b.win, variants, best });
    const sign = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
    console.log(`${key}: 4h biasa ${trades.length} trade, total ${sign(b.total)}R | ` + variants.map(v => `pullback ${v.pullback * 100}%/${v.windowH}j: ${v.filled}/${v.trades} terisi, total ${sign(v.totalR)}R`).join(" | "));
  }
  if (!rows.length) return;

  const sum = (f: (r: MtfRow) => number) => rows.reduce((a, r) => a + f(r), 0);
  const variantTotals = rows[0]!.variants.map((_, vi) => ({
    pullback: rows[0]!.variants[vi]!.pullback, windowH: rows[0]!.variants[vi]!.windowH,
    totalR: sum(r => r.variants[vi]!.totalR), filled: sum(r => r.variants[vi]!.filled), trades: sum(r => r.variants[vi]!.trades),
    better: rows.filter(r => r.variants[vi]!.totalR > r.baseTotalR).length,
  }));
  const baseTotal = sum(r => r.baseTotalR), baseTrades = sum(r => r.baseTrades);
  const createdAt = new Date().toISOString();
  const stamp = createdAt.replace(/[:.]/g, "-").slice(0, 19);
  writeJsonAtomic(path.join(SCALP_DIR, `mtf-${stamp}.json`), { createdAt, days: DAYS, baseTotal, baseTrades, variantTotals, rows });

  const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}R`;
  const md = [
    `# Sinyal 4h + entry 15m · ${createdAt.slice(0, 16).replace("T", " ")} UTC`, "",
    `${rows.length} strategi watchlist, ${DAYS} hari terakhir. Total R = jumlah hasil semua trade (tiap trade risiko 1R). Trade yang tidak sempat pullback dihitung 0R.`, "",
    "| Versi | Trade terisi | Total R | Koin yang lebih baik dari 4h biasa |", "|---|---|---|---|",
    `| 4h biasa (sekarang) | ${baseTrades} | ${s1(baseTotal)} | - |`,
    ...variantTotals.map(v => `| Pullback ${v.pullback * 100}% · tunggu ${v.windowH} jam | ${v.filled}/${v.trades} | ${s1(v.totalR)} | ${v.better}/${rows.length} |`),
    "", "## Per koin", "", "| Koin | 4h biasa | Terbaik versi 15m |", "|---|---|---|",
    ...rows.map(r => `| ${r.key} | ${r.baseTrades} trade, ${s1(r.baseTotalR)} | ${r.best ? `pullback ${r.best.pullback * 100}%/${r.best.windowH}j: ${r.best.filled} trade, ${s1(r.best.totalR)}` : "-"} |`),
    "", "> Riset saja. Bot live tidak berubah. Catatan: exit diasumsikan sama dengan trade 4h aslinya (trailing yang bergantung harga entry bisa sedikit berbeda).",
  ].join("\n");
  writeJsonAtomic(path.join(SCALP_DIR, `mtf-${stamp}.md`), md + "\n");
  console.log("\n" + md);
  console.log(`\nDitulis: ${path.join(SCALP_DIR, `mtf-${stamp}.md`)}`);
}

await main();
