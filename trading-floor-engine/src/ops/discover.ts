// Scan penemuan mingguan: top N koin USDT-M (urut volume 24 jam) × semua strategi di timeframe bot, dengan
// walk-forward + Monte Carlo yang sama persis seperti `npm run scan`. Hasilnya cuma USULAN: watchlist tidak
// pernah diubah otomatis. Hanya memakai data publik Binance; cache candle di data/ diperbarui secara bertahap.
import path from "node:path";
import { fetch24hQuoteVolume, fetchAllSymbols, fetchFunding, fetchKlines } from "../data/binance.js";
import { candlePath, fundingPath, loadCandles, loadFunding, saveJson } from "../data/store.js";
import { STRATEGIES } from "../strategies/index.js";
import { rankRows, scanOne, type ScanRow } from "../scan.js";
import { loadWatchlist } from "../exec/watchlist.js";
import { writeScanToOffice } from "../report/office.js";
import { TF_MS, type Candle, type FundingRate, type Timeframe } from "../types.js";
import { latestEquity, writeJsonAtomic } from "./common.js";
import { LAB_DIR } from "./lab.js";

const TOP = Number(process.env.DISCOVER_TOP ?? 100);
const TF = (process.env.DISCOVER_TF ?? "4h") as Timeframe;
const FROM = Date.parse("2020-01-01T00:00:00Z");
const MAX_NEW = 5;

export interface DiscoverRow {
  symbol: string; tf: string; strategyId: string;
  level: string; label: string;
  trades: number; pf: number; avgR: number; returnPct: number; maxDD: number;
  feasible: string; // sinyal yang lolos Risk Engine di equity asli, mis. "41/52"
}
export interface DiscoverResult {
  createdAt: string; tf: string; symbols: number; combos: number; candidates: number; realEquity: number;
  watchlist: (DiscoverRow | { symbol: string; tf: string; strategyId: string; level: "gagal"; label: string })[];
  fresh: DiscoverRow[];
  report: string;
}

const keyOf = (x: { symbol: string; tf: string; strategyId: string }) => `${x.symbol}|${x.tf}|${x.strategyId}`;

function toRow(r: ScanRow): DiscoverRow {
  const m = r.wf.oos.metrics;
  return {
    symbol: r.symbol, tf: r.tf, strategyId: r.strategyId, level: r.verdict.level, label: r.verdict.label,
    trades: m.trades, pf: m.profitFactor, avgR: m.avgR, returnPct: m.returnPct, maxDD: m.maxDrawdownPct,
    feasible: `${r.feasibility.accepted}/${r.feasibility.signals}`,
  };
}

/** Lanjutkan cache lokal dari candle terakhir, bukan ambil ulang dari 2020 (100 koin jadi beberapa menit, bukan belasan). */
export async function refreshData(symbol: string, tf: Timeframe): Promise<{ candles: Candle[]; funding: FundingRate[] }> {
  let old: Candle[] = [];
  try { old = loadCandles(symbol, tf); } catch { /* belum ada cache */ }
  const fresh = await fetchKlines(symbol, tf, old.length ? old.at(-1)!.t : FROM);
  const candles = [...new Map([...old, ...fresh].map(c => [c.t, c])).values()].sort((a, b) => a.t - b.t);
  saveJson(candlePath(symbol, tf), candles);

  const oldF = loadFunding(symbol);
  let freshF: FundingRate[] = [];
  try { freshF = await fetchFunding(symbol, oldF.length ? oldF.at(-1)!.t + 1 : FROM); } catch { /* funding opsional */ }
  const funding = [...new Map([...oldF, ...freshF].map(f => [f.t, f])).values()].sort((a, b) => a.t - b.t);
  saveJson(fundingPath(symbol), funding);
  return { candles, funding };
}

export async function runDiscover(onProgress: (m: string) => void = () => {}): Promise<{ file: string; result: DiscoverResult }> {
  const watch = loadWatchlist();
  const volume = await fetch24hQuoteVolume();
  const top = (await fetchAllSymbols()).sort((a, b) => (volume[b] ?? 0) - (volume[a] ?? 0)).slice(0, TOP);
  // Koin watchlist selalu ikut diuji walau sudah keluar dari top N.
  const symbols = [...new Set([...top, ...watch.filter(w => w.tf === TF).map(w => w.symbol)])];
  const realEquity = latestEquity() ?? 81.01;
  const bars = (d: number) => Math.round((d * 86_400_000) / TF_MS[TF]);
  const rows: ScanRow[] = [];

  for (const [i, symbol] of symbols.entries()) {
    onProgress(`Scan ${i + 1}/${symbols.length}: ${symbol} ${TF}`);
    let data: { candles: Candle[]; funding: FundingRate[] };
    try { data = await refreshData(symbol, TF); } catch (e) { onProgress(`  ${symbol} dilewati: ${(e as Error).message}`); continue; }
    for (const def of STRATEGIES) {
      try { rows.push(scanOne(symbol, TF, data.candles, data.funding, def, { trainBars: bars(365), testBars: bars(90), equity: 10_000, realEquity })); }
      catch { /* data terlalu pendek untuk walk-forward */ }
    }
  }

  const ranked = rankRows(rows);
  const report = writeScanToOffice(ranked, { synthetic: false, equity: 10_000, realEquity });
  const byKey = new Map(ranked.map(r => [keyOf(r), r]));
  const watchKeys = new Set(watch.map(keyOf));
  const watchSymbols = new Set(watch.map(w => w.symbol));
  const seen = new Set<string>();
  const fresh: DiscoverRow[] = [];
  for (const r of ranked) {
    if (fresh.length >= MAX_NEW || r.verdict.level !== "kandidat_paper") break;
    if (watchKeys.has(keyOf(r)) || watchSymbols.has(r.symbol) || seen.has(r.symbol)) continue;
    seen.add(r.symbol);
    fresh.push(toRow(r));
  }

  const result: DiscoverResult = {
    createdAt: new Date().toISOString(), tf: TF, symbols: symbols.length, combos: rows.length,
    candidates: ranked.filter(r => r.verdict.level === "kandidat_paper").length, realEquity,
    watchlist: watch.map(w => {
      const r = byKey.get(keyOf(w));
      return r ? toRow(r) : { symbol: w.symbol, tf: w.tf, strategyId: w.strategyId, level: "gagal" as const, label: "Tidak bisa diuji" };
    }),
    fresh, report: path.relative(process.cwd(), report),
  };
  const stamp = result.createdAt.replace(/[:.]/g, "-").slice(0, 19);
  const file = path.join(LAB_DIR, `discover-${stamp}.json`);
  writeJsonAtomic(file, result);
  return { file, result };
}

const ICON: Record<string, string> = { kandidat_paper: "🟢", edge_tipis: "🟡", sampel_kecil: "⚪", tanpa_edge: "⛔", gagal: "⚠️" };
const sign = (x: number, dp = 2) => `${x >= 0 ? "+" : ""}${x.toFixed(dp)}`;
const stats = (r: DiscoverRow) => `PF ${Number.isFinite(r.pf) ? r.pf.toFixed(2) : "∞"} · ${sign(r.avgR)}R · ${r.trades} trade · DD ${r.maxDD.toFixed(0)}%`;

export function discoverTelegram(d: DiscoverResult): string {
  const weak = d.watchlist.filter(w => w.level !== "kandidat_paper");
  return [
    `🔭 <b>Scan mingguan: top ${TOP} koin (${d.tf})</b>`,
    `<i>${d.combos} kombinasi koin×strategi diuji walk-forward, ${d.candidates} lolos jadi kandidat.</i>`,
    "",
    "<b>Watchlist sekarang</b>",
    ...d.watchlist.map(w => `${ICON[w.level] ?? "❔"} ${w.symbol} ${w.strategyId}: ${w.label}${"trades" in w ? ` · ${stats(w)}` : ""}`),
    "",
    "<b>Kandidat baru (belum di watchlist)</b>",
    ...(d.fresh.length
      ? d.fresh.map(r => `• ${r.symbol} ${r.strategyId} · ${stats(r)} · lolos risk ${r.feasible}`)
      : ["Tidak ada kandidat baru minggu ini."]),
    "",
    weak.length
      ? `⚠️ ${weak.map(w => w.symbol).join(", ")} tidak lagi lolos sebagai kandidat. Pertimbangkan ganti dengan kandidat baru di atas.`
      : "✅ Semua koin watchlist masih lolos.",
    "<i>Watchlist tidak diubah otomatis. Mau tukar koin? Minta Claude atau edit office/execution/watchlist.json, lalu restart bot.</i>",
  ].join("\n");
}
