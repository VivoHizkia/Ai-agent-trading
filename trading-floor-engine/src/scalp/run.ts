// Riset scalping (fase 1): ambil data 5m/15m lalu backtest walk-forward dengan fee & slippage asli.
// TIDAK mengirim order. Hasil ke office/scalp/scalp-<waktu>.json + .md (dibaca dashboard "Ruang Scalping").
//
//   npm run scalp:fetch   ambil candle 5m & 15m (default 120 hari, 8 koin paling likuid di luar watchlist)
//   npm run scalp:test    uji 3 strategi × target 0.5% / 1% / 2% (ROE 10/20/40% di 20x)
//
// .env opsional: SCALP_SYMBOLS=ETHUSDT,SOLUSDT  SCALP_DAYS=120  SCALP_TOP=8  SCALP_TARGETS=0.5,1,2  SCALP_TFS=5m,15m
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import type { Candle, Timeframe } from "../types.js";
import { TF_MS } from "../types.js";
import { fetch24hQuoteVolume, fetchAllSymbols, fetchKlines } from "../data/binance.js";
import { candlePath, loadFunding, saveJson } from "../data/store.js";
import { loadWatchlist } from "../exec/watchlist.js";
import { walkForward } from "../backtest/walkforward.js";
import { monteCarlo } from "../backtest/montecarlo.js";
import { verdict } from "../backtest/verdict.js";
import { DEFAULT_RULES } from "../risk/engine.js";
import { OFFICE_DIR } from "../report/office.js";
import { writeJsonAtomic } from "../ops/common.js";
import { SCALP_STRATEGIES } from "./strategies.js";

export const SCALP_DIR = path.join(OFFICE_DIR, "scalp");
const DAYS = Number(process.env.SCALP_DAYS ?? 120);
const TOP = Number(process.env.SCALP_TOP ?? 8);
const TFS = (process.env.SCALP_TFS ?? "5m,15m").split(",").map(s => s.trim()) as Timeframe[];
const TARGETS = (process.env.SCALP_TARGETS ?? "0.5,1,2").split(",").map(Number).filter(n => n > 0);
const LEV = 20; // hanya untuk menerjemahkan target ke ROE di laporan
const EVAL_RISK = 1;

async function symbolsToUse(): Promise<string[]> {
  if (process.env.SCALP_SYMBOLS) return process.env.SCALP_SYMBOLS.split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
  let watch = new Set<string>();
  try { watch = new Set(loadWatchlist().map(w => w.symbol)); } catch { /* kosong */ }
  const vol = await fetch24hQuoteVolume();
  // Koin watchlist bot 4h dilewati: di Binance satu koin hanya bisa satu posisi, scalper dan bot 4h tidak boleh bentrok.
  return (await fetchAllSymbols()).filter(s => !watch.has(s)).sort((a, b) => (vol[b] ?? 0) - (vol[a] ?? 0)).slice(0, TOP);
}

const loadLocal = (symbol: string, tf: Timeframe): Candle[] => {
  try { return JSON.parse(fs.readFileSync(candlePath(symbol, tf), "utf8")) as Candle[]; } catch { return []; }
};

async function cmdFetch() {
  const symbols = await symbolsToUse();
  const from = Date.now() - DAYS * 86_400_000;
  console.log(`Ambil ${DAYS} hari candle ${TFS.join(" & ")} untuk: ${symbols.join(", ")}`);
  for (const s of symbols) {
    for (const tf of TFS) {
      const old = loadLocal(s, tf).filter(c => c.t >= from);
      // Lanjutkan dari candle terakhir, KECUALI data lokal belum menjangkau awal rentang (mis. SCALP_DAYS dinaikkan): ambil ulang penuh.
      const covers = old.length > 0 && old[0]!.t <= from + 2 * TF_MS[tf];
      const start = covers ? old.at(-1)!.t + TF_MS[tf] : from;
      process.stdout.write(`${s} ${tf} ... `);
      try {
        const fresh = await fetchKlines(s, tf, start);
        const all = [...new Map([...old, ...fresh].map(c => [c.t, c])).values()].sort((a, b) => a.t - b.t);
        saveJson(candlePath(s, tf), all);
        console.log(`${all.length} candle`);
      } catch (e) { console.log(`gagal: ${(e as Error).message}`); }
    }
  }
  fs.mkdirSync(SCALP_DIR, { recursive: true });
  fs.writeFileSync(path.join(SCALP_DIR, "symbols.json"), JSON.stringify({ updatedAt: new Date().toISOString(), days: DAYS, tfs: TFS, symbols }, null, 2));
  console.log("Selesai. Lanjut: npm run scalp:test");
}

export interface ScalpRow {
  symbol: string; tf: string; strategyId: string; strategyName: string;
  targetPct: number; stopPct: number; roeTarget: number; roeStop: number;
  trades: number; perDay: number; winRate: number; avgR: number; grossR: number; feeR: number;
  pf: number; returnPct: number; maxDD: number; level: string; label: string;
}

function cmdTest() {
  let symbols: string[] = [];
  try { symbols = (JSON.parse(fs.readFileSync(path.join(SCALP_DIR, "symbols.json"), "utf8")) as { symbols: string[] }).symbols; } catch { /* belum fetch */ }
  if (process.env.SCALP_SYMBOLS) symbols = process.env.SCALP_SYMBOLS.split(",").map(s => s.trim().toUpperCase());
  if (!symbols.length) { console.log("Belum ada data. Jalankan dulu: npm run scalp:fetch"); return; }

  const rows: ScalpRow[] = [];
  for (const symbol of symbols) {
    for (const tf of TFS) {
      const candles = loadLocal(symbol, tf);
      if (candles.length < 500) { console.log(`${symbol} ${tf}: data kurang (${candles.length} candle), dilewati`); continue; }
      const bars = (d: number) => Math.round((d * 86_400_000) / TF_MS[tf]);
      const days = (candles.at(-1)!.t - candles[0]!.t) / 86_400_000;
      const funding = loadFunding(symbol);
      for (const def of SCALP_STRATEGIES) {
        for (const targetPct of TARGETS) {
          const fixed: typeof def = { ...def, defaults: { ...def.defaults, targetPct } };
          const cfg = { symbol, tf, initialEquity: 10_000, rules: { ...DEFAULT_RULES, riskPct: EVAL_RISK } };
          try {
            const wf = walkForward(candles, fixed, cfg, funding, { trainBars: bars(Math.min(30, days / 4)), testBars: bars(Math.min(10, days / 10)) });
            const m = wf.oos.metrics;
            const ts = wf.oos.trades;
            const feeRs = ts.filter(t => t.pnl !== 0 && t.r !== 0).map(t => t.fees * (t.r / t.pnl));
            const feeR = feeRs.length ? feeRs.reduce((a, b) => a + b, 0) / feeRs.length : 0;
            const v = verdict(m, monteCarlo(ts.map(t => t.r), EVAL_RISK, 2000, 7), wf.oos.buyHoldPct);
            const oosDays = Math.max((wf.oos.to - wf.oos.from) / 86_400_000, 1);
            const stopPct = targetPct / fixed.defaults.rr!;
            rows.push({
              symbol, tf, strategyId: def.id, strategyName: def.name, targetPct, stopPct,
              roeTarget: targetPct * LEV, roeStop: stopPct * LEV,
              trades: m.trades, perDay: m.trades / oosDays, winRate: m.winRatePct, avgR: m.avgR, grossR: m.avgR + feeR, feeR,
              pf: m.profitFactor, returnPct: m.returnPct, maxDD: m.maxDrawdownPct, level: v.level, label: v.label,
            });
            const r = rows.at(-1)!;
            console.log(`${symbol} ${tf} ${def.id} target ${targetPct}%: ${r.trades} trade, win ${r.winRate.toFixed(0)}%, ${r.avgR >= 0 ? "+" : ""}${r.avgR.toFixed(2)}R (sebelum fee ${r.grossR >= 0 ? "+" : ""}${r.grossR.toFixed(2)}R) → ${r.label}`);
          } catch (e) { console.log(`${symbol} ${tf} ${def.id} ${targetPct}%: ${(e as Error).message}`); }
        }
      }
    }
  }
  if (!rows.length) return;

  const RANK: Record<string, number> = { kandidat_paper: 3, edge_tipis: 2, sampel_kecil: 1, tanpa_edge: 0 };
  rows.sort((a, b) => RANK[b.level]! - RANK[a.level]! || b.avgR * Math.sqrt(b.trades) - a.avgR * Math.sqrt(a.trades));

  // Ringkasan per target & per strategi: rata-rata sederhana semua koin.
  const group = (k: (r: ScalpRow) => string) => [...rows.reduce((m, r) => m.set(k(r), [...(m.get(k(r)) ?? []), r]), new Map<string, ScalpRow[]>())]
    .map(([key, rs]) => ({ key, n: rs.length, positive: rs.filter(r => r.avgR > 0).length, kandidat: rs.filter(r => r.level === "kandidat_paper").length,
      avgR: rs.reduce((a, r) => a + r.avgR, 0) / rs.length, grossR: rs.reduce((a, r) => a + r.grossR, 0) / rs.length,
      winRate: rs.reduce((a, r) => a + r.winRate, 0) / rs.length, perDay: rs.reduce((a, r) => a + r.perDay, 0) / rs.length }));
  const byTarget = group(r => `${r.targetPct}%`);
  const byStrategy = group(r => r.strategyId);
  const byTf = group(r => r.tf);

  const createdAt = new Date().toISOString();
  const stamp = createdAt.replace(/[:.]/g, "-").slice(0, 19);
  const result = { createdAt, symbols, tfs: TFS, targets: TARGETS, leverageForRoe: LEV, evalRiskPct: EVAL_RISK, rows, byTarget, byStrategy, byTf };
  writeJsonAtomic(path.join(SCALP_DIR, `scalp-${stamp}.json`), result);

  const sign = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
  const g = (xs: typeof byTarget, title: string) => [`## ${title}`, "", "| | Uji | Positif | Kandidat | Win | Rata-rata | Sebelum fee | Trade/hari |", "|---|---|---|---|---|---|---|---|",
    ...xs.map(x => `| ${x.key} | ${x.n} | ${x.positive} | ${x.kandidat} | ${x.winRate.toFixed(0)}% | ${sign(x.avgR)}R | ${sign(x.grossR)}R | ${x.perDay.toFixed(1)} |`), ""];
  const md = [
    `# Riset scalping ${createdAt.slice(0, 16).replace("T", " ")} UTC`, "",
    `Koin: ${symbols.join(", ")} · TF: ${TFS.join(", ")} · walk-forward out-of-sample · fee taker 0.05%/maker 0.02% + slippage · risk evaluasi ${EVAL_RISK}%/trade.`,
    `Target persen harga; ROE dihitung di leverage ${LEV}x (target 1% = ROE +${LEV}%). Stop = setengah target.`, "",
    ...g(byTarget, "Per ukuran target"), ...g(byStrategy, "Per strategi"), ...g(byTf, "Per timeframe"),
    "## 15 hasil teratas", "", "| Koin | TF | Strategi | Target (ROE) | Trade | Win | Rata-rata | Sebelum fee | PF | DD | Vonis |", "|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows.slice(0, 15).map(r => `| ${r.symbol} | ${r.tf} | ${r.strategyId} | ${r.targetPct}% (${r.roeTarget.toFixed(0)}%) | ${r.trades} | ${r.winRate.toFixed(0)}% | ${sign(r.avgR)}R | ${sign(r.grossR)}R | ${Number.isFinite(r.pf) ? r.pf.toFixed(2) : "∞"} | ${r.maxDD.toFixed(1)}% | ${r.label} |`),
    "", "> Riset saja. Bot live tidak memakai hasil ini. Kandidat perlu dry run 1–2 minggu sebelum dipertimbangkan.",
  ].join("\n");
  writeJsonAtomic(path.join(SCALP_DIR, `scalp-${stamp}.md`), md + "\n");

  console.log("\n" + md.split("## 15 hasil teratas")[0]);
  console.log(`Kandidat paper: ${rows.filter(r => r.level === "kandidat_paper").length} dari ${rows.length} uji.`);
  console.log(`Ditulis: ${path.join(SCALP_DIR, `scalp-${stamp}.md`)}`);
}

const cmd = process.argv[2];
if (cmd === "fetch") await cmdFetch();
else if (cmd === "test") cmdTest();
else console.log("Pakai: npm run scalp:fetch | npm run scalp:test");
