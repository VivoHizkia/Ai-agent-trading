import type { Timeframe, Trade } from "../types.js";
import { TF_MS } from "../types.js";
import type { EquityPoint } from "./engine.js";

export interface Metrics {
  returnPct: number;
  cagrPct: number;
  maxDrawdownPct: number; // negatif
  calmar: number; // CAGR / |maxDD|
  sharpe: number; // tahunan, dari return per bar
  sortino: number;
  trades: number;
  winRatePct: number;
  profitFactor: number;
  avgR: number; // expectancy dalam R
  avgWinR: number;
  avgLossR: number;
  bestR: number;
  worstR: number;
  maxLosingStreak: number;
  avgBarsHeld: number;
  exposurePct: number; // % bar dengan posisi terbuka
  feesPaid: number;
  fundingNet: number; // negatif = dibayar
  liquidations: number;
  years: number;
}

export function computeMetrics(eq: EquityPoint[], trades: Trade[], initial: number, tf: Timeframe, bars: number): Metrics {
  const final = eq.length ? eq[eq.length - 1]!.equity : initial;
  const years = Math.max((bars * TF_MS[tf]) / (365 * 86_400_000), 1e-9);
  const ret = final / initial - 1;
  const cagr = final > 0 ? Math.pow(final / initial, 1 / years) - 1 : -1;

  let peak = initial, mdd = 0;
  for (const p of eq) { peak = Math.max(peak, p.equity); mdd = Math.min(mdd, p.equity / peak - 1); }

  const rets: number[] = [];
  let prev = initial;
  for (const p of eq) { rets.push(prev > 0 ? p.equity / prev - 1 : 0); prev = p.equity; }
  const perYear = (365 * 86_400_000) / TF_MS[tf];
  const mean = rets.reduce((a, b) => a + b, 0) / Math.max(rets.length, 1);
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(rets.length - 1, 1));
  const dsd = Math.sqrt(rets.reduce((a, b) => a + Math.min(0, b) ** 2, 0) / Math.max(rets.length - 1, 1));

  const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0), grossLoss = -losses.reduce((a, t) => a + t.pnl, 0);
  let streak = 0, maxStreak = 0;
  for (const t of trades) { streak = t.pnl <= 0 ? streak + 1 : 0; maxStreak = Math.max(maxStreak, streak); }
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const barsHeld = trades.reduce((a, t) => a + t.bars, 0);

  return {
    returnPct: ret * 100,
    cagrPct: cagr * 100,
    maxDrawdownPct: mdd * 100,
    calmar: mdd < 0 ? cagr / -mdd : cagr > 0 ? Infinity : 0,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(perYear) : 0,
    sortino: dsd > 0 ? (mean / dsd) * Math.sqrt(perYear) : 0,
    trades: trades.length,
    winRatePct: trades.length ? (wins.length / trades.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    avgR: avg(trades.map(t => t.r)),
    avgWinR: avg(wins.map(t => t.r)),
    avgLossR: avg(losses.map(t => t.r)),
    bestR: trades.length ? Math.max(...trades.map(t => t.r)) : 0,
    worstR: trades.length ? Math.min(...trades.map(t => t.r)) : 0,
    maxLosingStreak: maxStreak,
    avgBarsHeld: trades.length ? barsHeld / trades.length : 0,
    exposurePct: bars ? Math.min(100, (barsHeld / bars) * 100) : 0,
    feesPaid: trades.reduce((a, t) => a + t.fees, 0),
    fundingNet: trades.reduce((a, t) => a + t.funding, 0),
    liquidations: trades.filter(t => t.exitReason === "liquidation").length,
    years,
  };
}
