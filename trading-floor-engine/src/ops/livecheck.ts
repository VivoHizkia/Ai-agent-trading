// Live vs backtest: apakah trade live masih sejalan dengan backtest strategi yang sama?
// Pembanding = hasil walk-forward out-of-sample (setelan disetel ulang tiap 90 hari dari 365 hari sebelumnya), yaitu
// cara yang sama dengan bot (src/ops/tuning.ts), risk evaluasi 1%. Hanya membaca; tidak mengubah bot.
import fs from "node:fs";
import path from "node:path";
import { loadWatchlist } from "../exec/watchlist.js";
import { scanOne } from "../scan.js";
import { getStrategy } from "../strategies/index.js";
import { TF_MS, type Timeframe } from "../types.js";
import { refreshData } from "./discover.js";
import { EXEC_DIR, tradeRecords, writeJsonAtomic, type TradeRecord } from "./common.js";

export const EXPECT_FILE = path.join(EXEC_DIR, "expectations.json");
const MAX_AGE_MS = 7 * 86_400_000;

export interface Expectation { trades: number; winRate: number; avgR: number; sdR: number; from: string }
export interface Expectations { createdAt: string; rows: Record<string, Expectation> }

export const tradeKey = (x: { symbol: string; tf: string; strategyId: string }) => `${x.symbol} ${x.tf} ${x.strategyId}`;

export function readExpectations(): Expectations | null {
  try { return JSON.parse(fs.readFileSync(EXPECT_FILE, "utf8")) as Expectations; } catch { return null; }
}

export function expectationsStale(now = Date.now()): boolean {
  const e = readExpectations();
  return !e || now - Date.parse(e.createdAt) > MAX_AGE_MS;
}

/** Backtest pembanding untuk semua baris watchlist (data publik, cache data/ diperbarui bertahap). */
export async function buildExpectations(onProgress: (m: string) => void = () => {}): Promise<Expectations> {
  const rows: Record<string, Expectation> = {};
  for (const w of loadWatchlist()) {
    const tf = w.tf as Timeframe;
    try {
      const { candles, funding } = await refreshData(w.symbol, tf);
      const def = getStrategy(w.strategyId);
      const bars = (d: number) => Math.round((d * 86_400_000) / TF_MS[tf]);
      const oos = scanOne(w.symbol, tf, candles, funding, def, { trainBars: bars(365), testBars: bars(90), equity: 10_000, realEquity: 10_000 }).wf.oos;
      const r = { trades: oos.trades };
      const rs = r.trades.map(t => t.r);
      if (rs.length < 10) { onProgress(`${tradeKey(w)}: hanya ${rs.length} trade di backtest, dilewati`); continue; }
      const mean = rs.reduce((s, x) => s + x, 0) / rs.length;
      const sd = Math.sqrt(rs.reduce((s, x) => s + (x - mean) ** 2, 0) / (rs.length - 1));
      rows[tradeKey(w)] = { trades: rs.length, winRate: r.trades.filter(t => t.pnl > 0).length / rs.length, avgR: mean, sdR: sd, from: new Date(oos.from).toISOString().slice(0, 10) };
      onProgress(`${tradeKey(w)}: ${rs.length} trade, win ${(rows[tradeKey(w)]!.winRate * 100).toFixed(0)}%, ${mean.toFixed(2)}R`);
    } catch (e) { onProgress(`${tradeKey(w)}: gagal (${(e as Error).message})`); }
  }
  const out = { createdAt: new Date().toISOString(), rows };
  writeJsonAtomic(EXPECT_FILE, out);
  return out;
}

export type LiveStatus = "terlalu sedikit" | "wajar" | "di bawah" | "jauh di bawah" | "tanpa pembanding";

export interface LiveCheck {
  n: number; // trade live yang punya pembanding
  unmatched: number;
  liveWin: number; expWin: number;
  liveAvgR: number; expAvgR: number;
  liveSumR: number; expSumR: number;
  z: number;
  status: LiveStatus;
  /** Kalah beruntun di akhir dan peluangnya menurut backtest. */
  streak: number; streakP: number;
  perKey: { key: string; n: number; liveAvgR: number; expAvgR: number; liveWin: number; expWin: number }[];
}

export const liveTrades = (): TradeRecord[] => tradeRecords().filter(t => t.mode === "live" && Number.isFinite(t.r));

export function liveCheck(trades = liveTrades(), exp = readExpectations()): LiveCheck {
  const rows = exp?.rows ?? {};
  const matched = trades.map(t => ({ t, e: rows[tradeKey(t)] })).filter((x): x is { t: TradeRecord; e: Expectation } => !!x.e);
  const n = matched.length;
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
  const liveAvgR = mean(matched.map(x => x.t.r));
  const expAvgR = mean(matched.map(x => x.e.avgR));
  // z: selisih rata-rata live vs harapan, dibagi galat baku dari sebaran R di backtest.
  const se = Math.sqrt(mean(matched.map(x => x.e.sdR ** 2)) / Math.max(n, 1));
  const z = n && se > 0 ? (liveAvgR - expAvgR) / se : 0;
  const status: LiveStatus = !exp ? "tanpa pembanding" : n < 10 ? "terlalu sedikit" : z <= -2 ? "jauh di bawah" : z <= -1 ? "di bawah" : "wajar";

  let streak = 0, streakP = 1;
  for (let i = matched.length - 1; i >= 0 && matched[i]!.t.pnl < 0; i--) { streak++; streakP *= 1 - matched[i]!.e.winRate; }

  const groups = new Map<string, typeof matched>();
  for (const x of matched) groups.set(tradeKey(x.t), [...(groups.get(tradeKey(x.t)) ?? []), x]);
  const perKey = [...groups.entries()].filter(([, g]) => g.length >= 5).map(([key, g]) => ({
    key, n: g.length, liveAvgR: mean(g.map(x => x.t.r)), expAvgR: g[0]!.e.avgR,
    liveWin: g.filter(x => x.t.pnl > 0).length / g.length, expWin: g[0]!.e.winRate,
  }));

  return {
    n, unmatched: trades.length - n,
    liveWin: n ? matched.filter(x => x.t.pnl > 0).length / n : 0, expWin: mean(matched.map(x => x.e.winRate)),
    liveAvgR, expAvgR, liveSumR: liveAvgR * n, expSumR: expAvgR * n, z, status, streak, streakP, perKey,
  };
}

const ICON: Record<LiveStatus, string> = { wajar: "🟢", "di bawah": "🟡", "jauh di bawah": "🔴", "terlalu sedikit": "⚪", "tanpa pembanding": "⚪" };
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const sR = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(2)}R`;

export function liveReportText(c: LiveCheck): string {
  if (c.status === "tanpa pembanding") return "📏 <b>Live vs backtest</b>\nPembanding backtest belum dibuat. Notifier membuatnya otomatis (beberapa menit setelah jalan), atau jalankan <code>npm run livecheck</code>.";
  const head = [`📏 <b>Live vs backtest</b> (${c.n} trade live)`];
  if (c.n === 0) return [...head, "Belum ada trade live yang selesai. Laporan otomatis dikirim tiap 10 trade."].join("\n");
  const verdict: Record<LiveStatus, string> = {
    wajar: "Masih sejalan dengan backtest.",
    "di bawah": "Di bawah backtest, tapi selisih segini masih bisa terjadi karena kebetulan. Pantau terus.",
    "jauh di bawah": "JAUH di bawah backtest: peluang selisih sebesar ini terjadi karena kebetulan kurang dari ±2,5%. Strategi mungkin tidak lagi cocok dengan pasar sekarang. Pertimbangkan turunkan risk atau keluarkan strategi yang paling buruk.",
    "terlalu sedikit": `Baru ${c.n} trade; butuh minimal 10 untuk menilai. Angka di atas belum berarti apa-apa.`,
    "tanpa pembanding": "",
  };
  return [
    ...head,
    `Win rate: live <b>${pct(c.liveWin)}</b> vs backtest ${pct(c.expWin)}`,
    `Rata-rata per trade: live <b>${sR(c.liveAvgR)}</b> vs backtest ${sR(c.expAvgR)}`,
    `Total: live ${sR(c.liveSumR)} (backtest memperkirakan sekitar ${sR(c.expSumR)})`,
    "",
    `${ICON[c.status]} ${verdict[c.status]}`,
    ...(c.perKey.length ? ["", "<b>Per strategi</b> (min. 5 trade)", ...c.perKey.map(k => `• ${k.key}: ${k.n} trade, ${sR(k.liveAvgR)} vs ${sR(k.expAvgR)}, win ${pct(k.liveWin)} vs ${pct(k.expWin)}`)] : []),
    ...(c.unmatched ? [`<i>${c.unmatched} trade tanpa pembanding (strategi sudah tidak di watchlist).</i>`] : []),
    "<i>Hanya laporan: bot tetap jalan seperti biasa.</i>",
  ].join("\n");
}

export function streakWarningText(c: LiveCheck): string {
  return `⚠️ <b>Kalah ${c.streak}x berturut-turut</b>\nMenurut backtest, rentetan seperti ini peluangnya hanya ±${(c.streakP * 100).toFixed(1)}%. Bisa sial biasa, bisa juga tanda strategi tidak cocok dengan pasar sekarang.\n<i>Bot tetap jalan. Kirim /live untuk perbandingan lengkap.</i>`;
}
