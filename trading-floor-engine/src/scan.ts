// Scan: semua strategi × aset × timeframe, masing-masing lewat walk-forward + Monte Carlo + cek kelayakan equity kecil.
import type { Candle, FundingRate, Timeframe } from "./types.js";
import { STRATEGIES, type Params, type StrategyDef } from "./strategies/index.js";
import { runBacktest } from "./backtest/engine.js";
import { walkForward, type WalkForwardResult } from "./backtest/walkforward.js";
import { monteCarlo, type MonteCarloResult } from "./backtest/montecarlo.js";
import { verdict, type Verdict } from "./backtest/verdict.js";
import { DEFAULT_RULES } from "./risk/engine.js";

// Edge dinilai di risk tetap 1%/trade supaya vonis (batas max DD -25%) tidak ikut berubah saat risk live dinaikkan.
// Cek kelayakan di equity asli tetap memakai aturan live (DEFAULT_RULES).
export const EVAL_RISK_PCT = Number(process.env.SCAN_EVAL_RISK_PCT ?? 1);

export interface ScanRow {
  symbol: string;
  tf: Timeframe;
  strategyId: string;
  strategyName: string;
  grid: Record<string, number[]>;
  wf: WalkForwardResult;
  mc: MonteCarloResult | null;
  verdict: Verdict;
  feasibility: { equity: number; signals: number; accepted: number; topRejection: string | null };
}

const RANK: Record<string, number> = { kandidat_paper: 3, edge_tipis: 2, sampel_kecil: 1, tanpa_edge: 0 };

export function scanOne(
  symbol: string, tf: Timeframe, candles: Candle[], funding: FundingRate[], def: StrategyDef,
  o: { trainBars: number; testBars: number; equity: number; realEquity: number },
): ScanRow {
  const cfg = { symbol, tf, initialEquity: o.equity, rules: { ...DEFAULT_RULES, riskPct: EVAL_RISK_PCT } };
  const wf = walkForward(candles, def, cfg, funding, { trainBars: o.trainBars, testBars: o.testBars });
  const mc = monteCarlo(wf.oos.trades.map(t => t.r), 1, 2000, 7);
  // Kelayakan: parameter default, equity asli kamu. Berapa sinyal yang lolos Risk Engine (min notional, dll)?
  const small = runBacktest(candles, def.create({ ...def.defaults } as Params), { symbol, tf, initialEquity: o.realEquity }, funding);
  const rej = Object.entries(small.rejections).sort((a, b) => b[1] - a[1]);
  return {
    symbol, tf, strategyId: def.id, strategyName: def.name, grid: def.grid, wf, mc,
    verdict: verdict(wf.oos.metrics, mc, wf.oos.buyHoldPct),
    feasibility: { equity: o.realEquity, signals: small.signals, accepted: small.trades.length, topRejection: rej[0]?.[0] ?? null },
  };
}

export function rankRows(rows: ScanRow[]): ScanRow[] {
  return [...rows].sort((a, b) =>
    RANK[b.verdict.level]! - RANK[a.verdict.level]! ||
    (b.wf.oos.metrics.avgR * Math.sqrt(b.wf.oos.metrics.trades)) - (a.wf.oos.metrics.avgR * Math.sqrt(a.wf.oos.metrics.trades)));
}

export { STRATEGIES };
