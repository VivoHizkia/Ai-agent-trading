// Lab R&D: uji ulang strategi yang sedang live (watchlist) memakai data TERBARU, dengan walk-forward yang sama
// persis seperti scan. Lalu bandingkan 180 hari OOS terakhir dengan keseluruhan OOS untuk mendeteksi strategi
// yang mulai melemah. Hanya membaca data publik Binance; tidak mengubah watchlist atau data/ engine.
import path from "node:path";
import { fetchFunding, fetchKlines } from "../data/binance.js";
import { getStrategy } from "../strategies/index.js";
import { scanOne } from "../scan.js";
import { loadWatchlist } from "../exec/watchlist.js";
import { TF_MS, type Timeframe, type Trade } from "../types.js";
import { OFFICE_DIR } from "../report/office.js";
import { latestEquity, writeJsonAtomic } from "./common.js";

export const LAB_DIR = path.join(OFFICE_DIR, "lab");
const RECENT_DAYS = Number(process.env.LAB_RECENT_DAYS ?? 180);
const FROM = Date.parse(`${process.env.LAB_FROM ?? "2022-01-01"}T00:00:00Z`);

export interface LabRow {
  symbol: string; tf: string; strategyId: string; strategyName: string;
  full: { trades: number; winRate: number; avgR: number; returnPct: number; maxDD: number; pf: number };
  recent: { days: number; trades: number; winRate: number; avgR: number };
  verdict: string;
  status: "stabil" | "melemah" | "membaik" | "sampel kecil" | "tanpa edge" | "gagal";
  note: string;
}

const summarize = (ts: Trade[]) => ({
  trades: ts.length,
  winRate: ts.length ? (ts.filter(t => t.pnl > 0).length / ts.length) * 100 : 0,
  avgR: ts.length ? ts.reduce((s, t) => s + t.r, 0) / ts.length : 0,
});

export async function runLab(onProgress: (m: string) => void = () => {}): Promise<{ file: string; rows: LabRow[] }> {
  const watch = loadWatchlist();
  const realEquity = latestEquity() ?? 81.01;
  const rows: LabRow[] = [];
  for (const w of watch) {
    const tf = w.tf as Timeframe;
    const def = getStrategy(w.strategyId);
    onProgress(`Lab: uji ulang ${w.symbol} ${tf} ${w.strategyId}...`);
    try {
      const [candles, funding] = await Promise.all([fetchKlines(w.symbol, tf, FROM), fetchFunding(w.symbol, FROM).catch(() => [])]);
      const bars = (d: number) => Math.round((d * 86_400_000) / TF_MS[tf]);
      const row = scanOne(w.symbol, tf, candles, funding, def, { trainBars: bars(365), testBars: bars(90), equity: 10_000, realEquity });
      const m = row.wf.oos.metrics;
      const cut = Date.now() - RECENT_DAYS * 86_400_000;
      const full = summarize(row.wf.oos.trades), recent = summarize(row.wf.oos.trades.filter(t => t.exitTime >= cut));
      let status: LabRow["status"] = "stabil", note = "Performa 180 hari terakhir sejalan dengan keseluruhan OOS.";
      if (recent.trades < 5) { status = "sampel kecil"; note = `Hanya ${recent.trades} trade dalam ${RECENT_DAYS} hari terakhir.`; }
      else if (full.avgR <= 0) { status = "tanpa edge"; note = `Keseluruhan OOS rata-rata ${full.avgR.toFixed(2)}R: strategi ini tidak punya edge di data terbaru. Sebaiknya tidak di watchlist.`; }
      else if (recent.avgR < 0 || recent.avgR < full.avgR - 0.3) { status = "melemah"; note = `Rata-rata ${recent.avgR.toFixed(2)}R di ${RECENT_DAYS} hari terakhir vs ${full.avgR.toFixed(2)}R keseluruhan. Pertimbangkan keluarkan dari watchlist atau kecilkan risiko.`; }
      else if (recent.avgR > full.avgR + 0.3) { status = "membaik"; note = `Rata-rata ${recent.avgR.toFixed(2)}R di ${RECENT_DAYS} hari terakhir, di atas keseluruhan ${full.avgR.toFixed(2)}R.`; }
      rows.push({
        symbol: w.symbol, tf, strategyId: w.strategyId, strategyName: def.name,
        full: { trades: full.trades, winRate: full.winRate, avgR: full.avgR, returnPct: m.returnPct, maxDD: m.maxDrawdownPct, pf: m.profitFactor },
        recent: { days: RECENT_DAYS, ...recent }, verdict: row.verdict.label, status, note,
      });
    } catch (e) {
      rows.push({
        symbol: w.symbol, tf, strategyId: w.strategyId, strategyName: def.name,
        full: { trades: 0, winRate: 0, avgR: 0, returnPct: 0, maxDD: 0, pf: 0 }, recent: { days: RECENT_DAYS, trades: 0, winRate: 0, avgR: 0 },
        verdict: "-", status: "gagal", note: (e as Error).message.slice(0, 200),
      });
    }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = path.join(LAB_DIR, `lab-${stamp}.json`);
  writeJsonAtomic(file, { createdAt: new Date().toISOString(), from: new Date(FROM).toISOString().slice(0, 10), recentDays: RECENT_DAYS, rows });
  return { file, rows };
}

export function labTelegram(rows: LabRow[]): string {
  const icon: Record<LabRow["status"], string> = { stabil: "🟢", membaik: "🔵", melemah: "🔴", "sampel kecil": "⚪", "tanpa edge": "⛔", gagal: "⚠️" };
  return [`🧪 <b>Lab R&D: uji ulang mingguan</b>`, ...rows.map(r => `${icon[r.status]} ${r.symbol} ${r.tf} ${r.strategyId}: ${r.status} (${r.recent.trades} trade, ${r.recent.avgR >= 0 ? "+" : ""}${r.recent.avgR.toFixed(2)}R di ${r.recent.days} hari terakhir)`)].join("\n");
}
