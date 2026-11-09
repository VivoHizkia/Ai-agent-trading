// Walk-forward: pilih parameter terbaik di jendela train, uji di jendela test berikutnya yang belum pernah dilihat,
// lalu sambung semua jendela test jadi satu hasil out-of-sample (OOS). Ini yang jadi dasar keputusan, bukan hasil in-sample.
import type { Candle, FundingRate, Trade } from "../types.js";
import { gridCombos, type Params, type StrategyDef } from "../strategies/index.js";
import { runBacktest, type BacktestConfig, type BacktestResult, type EquityPoint } from "./engine.js";
import { computeMetrics, type Metrics } from "./metrics.js";

export interface WalkForwardWindow {
  trainFrom: number; trainTo: number; testFrom: number; testTo: number;
  params: Params; trainScore: number; testReturnPct: number; testTrades: number;
}

export interface WalkForwardResult {
  strategy: string;
  windows: WalkForwardWindow[];
  oos: { trades: Trade[]; equity: EquityPoint[]; metrics: Metrics; from: number; to: number; buyHoldPct: number };
  defaultsOnSameSpan: BacktestResult; // parameter default tanpa optimasi, di rentang OOS yang sama
  combosTried: number;
}

/** Skor train: return per unit drawdown, butuh trade minimal supaya tidak memilih kebetulan. */
export function trainScore(r: BacktestResult, minTrades = 4): number {
  if (r.metrics.trades < minTrades) return -Infinity;
  return r.metrics.returnPct / Math.max(-r.metrics.maxDrawdownPct, 5);
}

/** Pilih setelan terbaik (skor train tertinggi) di rentang bar trS..trE. Dipakai walk-forward DAN penyetelan live
 * (src/ops/tuning.ts), supaya bot memilih setelan dengan cara yang sama persis seperti yang diuji. */
export function selectParams(
  candles: Candle[], def: StrategyDef, cfg: BacktestConfig, funding: FundingRate[], trS: number, trE: number,
): { params: Params; score: number } {
  const combos = gridCombos(def.grid).map(g => ({ ...def.defaults, ...g }));
  let best = combos[0]!, bestScore = -Infinity;
  for (const p of combos) {
    const r = runBacktest(candles, def.create(p), { ...cfg, startIndex: trS, endIndex: trE, initialEquity: 10_000 }, funding);
    const s = trainScore(r);
    if (s > bestScore) { bestScore = s; best = p; }
  }
  // Kalau tidak ada kombinasi yang layak di train, tetap pakai default (jangan pilih yang "paling tidak jelek").
  if (!Number.isFinite(bestScore)) best = { ...def.defaults };
  return { params: best, score: bestScore };
}

export function walkForward(
  candles: Candle[], def: StrategyDef, cfg: BacktestConfig, funding: FundingRate[],
  opts: { trainBars: number; testBars: number },
): WalkForwardResult {
  const combos = gridCombos(def.grid).map(g => ({ ...def.defaults, ...g }));
  const warmup = Math.max(...combos.map(p => def.create(p).warmup));
  const initial = cfg.initialEquity ?? 10_000;
  const windows: WalkForwardWindow[] = [];
  const trades: Trade[] = [];
  const equity: EquityPoint[] = [];
  let carried = initial;
  const firstTest = warmup + opts.trainBars;
  if (firstTest >= candles.length - 1) throw new Error(`Data kurang: butuh > ${firstTest} bar untuk walk-forward (warmup ${warmup} + train ${opts.trainBars})`);

  for (let ts = firstTest; ts < candles.length; ts += opts.testBars) {
    const trS = ts - opts.trainBars, trE = ts - 1;
    const te = Math.min(candles.length - 1, ts + opts.testBars - 1);
    if (te - ts < 2) break;
    const { params: best, score: bestScore } = selectParams(candles, def, cfg, funding, trS, trE);
    const test = runBacktest(candles, def.create(best), { ...cfg, startIndex: ts, endIndex: te, initialEquity: carried }, funding);
    trades.push(...test.trades);
    equity.push(...test.equity);
    carried = test.finalEquity;
    windows.push({
      trainFrom: candles[trS]!.t, trainTo: candles[trE]!.t, testFrom: candles[ts]!.t, testTo: candles[te]!.t,
      params: best, trainScore: bestScore, testReturnPct: test.metrics.returnPct, testTrades: test.trades.length,
    });
  }

  const lastIdx = candles.length - 1;
  const oosBars = lastIdx - firstTest + 1;
  const defaultsOnSameSpan = runBacktest(candles, def.create({ ...def.defaults }), { ...cfg, startIndex: firstTest, endIndex: lastIdx, initialEquity: initial }, funding);
  return {
    strategy: def.id,
    windows,
    oos: {
      trades, equity, metrics: computeMetrics(equity, trades, initial, cfg.tf, oosBars),
      from: candles[firstTest]!.t, to: candles[lastIdx]!.t,
      buyHoldPct: (candles[lastIdx]!.c / candles[firstTest]!.o - 1) * 100,
    },
    defaultsOnSameSpan,
    combosTried: combos.length,
  };
}
