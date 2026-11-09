// Backtester futures bar-by-bar.
// Aturan realisme:
//  - Sinyal di close bar i, entry di OPEN bar i+1 (+slippage). Tidak ada look-ahead.
//  - Size dihitung Risk Engine dari harga close bar sinyal; entry dibatalkan kalau open sudah melewati stop.
//  - SL dan TP dicek intrabar dari high/low. Kalau keduanya tersentuh di bar yang sama, dianggap SL dulu (pesimis).
//  - Gap melewati stop dieksekusi di open (lebih buruk dari stop).
//  - Fee taker untuk entry/stop/exit market, fee maker untuk TP limit.
//  - Funding dibayar/diterima tiap settlement 8 jam selama posisi terbuka (data asli kalau ada, default 0.01%).
//  - Likuidasi isolated margin: kalau harga menembus harga likuidasi, margin hilang.
//  - Batas rugi harian (zona WIB) memblokir entry baru lewat Risk Engine.
import type { Candle, ExitReason, FundingRate, Intent, MarketSpec, Position, Timeframe, Trade } from "../types.js";
import { TF_MS, marketSpec } from "../types.js";
import type { Strategy } from "../strategies/index.js";
import { DEFAULT_RULES, evaluateRisk, liquidationPrice, type RiskDecision, type RiskRules } from "../risk/engine.js";
import { computeMetrics, type Metrics } from "./metrics.js";

export interface BacktestConfig {
  symbol: string;
  tf: Timeframe;
  initialEquity?: number;
  spec?: MarketSpec;
  rules?: RiskRules;
  slippage?: number; // fraksi, default 0.0002 (2 bps)
  defaultFundingRate?: number; // dipakai kalau tidak ada data funding
  startIndex?: number; // bar pertama yang boleh entry (indikator tetap dihitung dari awal)
  endIndex?: number; // bar terakhir (inklusif); posisi ditutup di close bar ini
  dayOffsetMs?: number; // zona waktu batas harian, default WIB (+7 jam)
}

export interface EquityPoint { t: number; equity: number }

export interface BacktestResult {
  symbol: string;
  tf: Timeframe;
  strategy: { id: string; params: Record<string, number> };
  from: number;
  to: number;
  initialEquity: number;
  finalEquity: number;
  trades: Trade[];
  equity: EquityPoint[];
  signals: number;
  rejections: Record<string, number>;
  buyHoldPct: number;
  metrics: Metrics;
}

const EIGHT_H = 8 * 3_600_000;

function defaultFunding(from: number, to: number, rate: number): FundingRate[] {
  const out: FundingRate[] = [];
  for (let t = Math.ceil(from / EIGHT_H) * EIGHT_H; t <= to; t += EIGHT_H) out.push({ t, rate });
  return out;
}

export function runBacktest(candles: Candle[], strategy: Strategy, cfg: BacktestConfig, funding: FundingRate[] = []): BacktestResult {
  const spec = cfg.spec ?? marketSpec(cfg.symbol);
  const rules = cfg.rules ?? DEFAULT_RULES;
  const slip = cfg.slippage ?? 0.0002;
  const step = TF_MS[cfg.tf];
  const dayOffset = cfg.dayOffsetMs ?? 7 * 3_600_000;
  const initial = cfg.initialEquity ?? 10_000;
  const end = Math.min(cfg.endIndex ?? candles.length - 1, candles.length - 1);
  const start = Math.max(strategy.warmup, cfg.startIndex ?? 0);
  if (start > end) throw new Error(`Data terlalu pendek: butuh lebih dari ${strategy.warmup} bar untuk warmup`);

  strategy.prepare(candles);

  const fund = funding.length ? funding : defaultFunding(candles[0]!.t, candles[end]!.t + step, cfg.defaultFundingRate ?? 0.0001);
  let fIdx = 0;

  let cash = initial;
  let pos: Position | null = null;
  let pendingEntry: { intent: Intent; d: RiskDecision } | null = null;
  let pendingExit: { reason: string } | null = null;
  const trades: Trade[] = [];
  const equity: EquityPoint[] = [];
  const rejections: Record<string, number> = {};
  let signals = 0;
  let dayKey = -1, dayStartEquity = initial;
  const reject = (k: string) => (rejections[k] = (rejections[k] ?? 0) + 1);
  const dirSign = (p: Position) => (p.side === "long" ? 1 : -1);
  const unrealized = (p: Position, px: number) => (px - p.entry) * p.qty * dirSign(p);

  function close(p: Position, i: number, price: number, reason: ExitReason, fee: number, forcedPnl?: number) {
    const gross = forcedPnl ?? (price - p.entry) * p.qty * dirSign(p);
    const exitFee = p.qty * price * fee;
    cash += gross - exitFee;
    const pnl = gross - p.fees - exitFee + p.funding;
    trades.push({
      side: p.side, entryTime: p.entryTime, exitTime: candles[i]!.t, entry: p.entry, exit: price, qty: p.qty,
      leverage: p.leverage, pnl, fees: p.fees + exitFee, funding: p.funding, r: pnl / p.riskUsd,
      bars: i - p.entryIndex + 1, exitReason: reason, entryReason: p.reason,
    });
    pos = null;
  }

  for (let i = start; i <= end; i++) {
    const b = candles[i]!;

    // Batas hari (WIB): equity awal hari = equity di close bar sebelumnya.
    const dk = Math.floor((b.t + dayOffset) / 86_400_000);
    if (dk !== dayKey) {
      dayKey = dk;
      dayStartEquity = equity.length ? equity[equity.length - 1]!.equity : initial;
    }

    // 1) Order yang dijadwalkan di close sebelumnya, dieksekusi di open bar ini.
    if (pendingExit && pos) {
      const p: Position = pos;
      const px = p.side === "long" ? b.o * (1 - slip) : b.o * (1 + slip);
      close(p, i, px, pendingExit.reason.startsWith("trail") ? "trailing" : "signal", spec.takerFee);
    }
    pendingExit = null;

    if (pendingEntry && !pos) {
      const { intent, d } = pendingEntry;
      const fill = intent.side === "long" ? b.o * (1 + slip) : b.o * (1 - slip);
      const gapped = intent.side === "long" ? fill <= intent.stop : fill >= intent.stop;
      if (gapped) reject("gap_lewat_stop");
      else {
        const fee = d.qty * fill * spec.takerFee;
        cash -= fee;
        pos = {
          side: intent.side, entry: fill, qty: d.qty, stop: intent.stop, initialStop: intent.stop, target: intent.target,
          leverage: d.leverage, margin: (d.qty * fill) / d.leverage,
          liq: liquidationPrice(intent.side, fill, d.leverage, spec.maintenanceMarginRate),
          entryIndex: i, entryTime: b.t, riskUsd: d.qty * Math.abs(fill - intent.stop) || d.riskUsd,
          fees: fee, funding: 0, reason: intent.reason,
        };
      }
    }
    pendingEntry = null;

    // 2) Funding selama bar ini (settlement setelah waktu entry).
    while (fIdx < fund.length && fund[fIdx]!.t < b.t) fIdx++;
    if (pos) {
      const p: Position = pos;
      for (let k = fIdx; k < fund.length && fund[k]!.t < b.t + step; k++) {
        if (fund[k]!.t <= p.entryTime) continue;
        const pay = p.qty * b.o * fund[k]!.rate * dirSign(p); // positif = posisi membayar
        cash -= pay; p.funding -= pay;
      }
    }

    // 3) Exit intrabar: likuidasi/gap → stop → target (urutan pesimis).
    if (pos) {
      const p: Position = pos;
      const stopKind: ExitReason = p.stop !== p.initialStop ? "trailing" : "stop";
      if (p.side === "long") {
        if (b.o <= p.liq || b.l <= p.liq && p.liq >= p.stop) close(p, i, p.liq, "liquidation", spec.takerFee, -p.margin);
        else if (b.o <= p.stop) close(p, i, b.o * (1 - slip), stopKind, spec.takerFee);
        else if (b.l <= p.stop) close(p, i, p.stop * (1 - slip), stopKind, spec.takerFee);
        else if (p.target !== undefined && b.h >= p.target) close(p, i, Math.max(p.target, b.o), "target", spec.makerFee);
      } else {
        if (b.o >= p.liq || b.h >= p.liq && p.liq <= p.stop) close(p, i, p.liq, "liquidation", spec.takerFee, -p.margin);
        else if (b.o >= p.stop) close(p, i, b.o * (1 + slip), stopKind, spec.takerFee);
        else if (b.h >= p.stop) close(p, i, p.stop * (1 + slip), stopKind, spec.takerFee);
        else if (p.target !== undefined && b.l <= p.target) close(p, i, Math.min(p.target, b.o), "target", spec.makerFee);
      }
    }

    // 4) Close bar: catat equity, lalu keputusan strategi.
    const eqNow = cash + (pos ? unrealized(pos, b.c) : 0);
    equity.push({ t: b.t, equity: eqNow });

    if (i === end) {
      if (pos) close(pos, i, (pos as Position).side === "long" ? b.c * (1 - slip) : b.c * (1 + slip), "end", spec.takerFee);
      equity[equity.length - 1] = { t: b.t, equity: cash };
      break;
    }

    if (pos) {
      const p: Position = pos;
      const m = strategy.manage(i, p);
      if (m?.newStop !== undefined && Number.isFinite(m.newStop)) {
        const tighter = p.side === "long" ? m.newStop > p.stop && m.newStop < b.c : m.newStop < p.stop && m.newStop > b.c;
        if (tighter) p.stop = m.newStop;
      }
      if (m?.exit) pendingExit = { reason: m.reason ?? "signal" };
    } else {
      const intent = strategy.signal(i);
      if (intent) {
        signals++;
        const d = evaluateRisk({
          intent, refPrice: b.c, equity: eqNow, dayStartEquity, dayPnl: eqNow - dayStartEquity,
          openPositions: 0, spec, trailingExit: strategy.trailing, rules,
        });
        if (d.ok) pendingEntry = { intent, d };
        else d.rejections.forEach(reject);
      }
    }
  }

  const first = candles[start]!, last = candles[end]!;
  const finalEquity = cash;
  return {
    symbol: cfg.symbol, tf: cfg.tf, strategy: { id: strategy.id, params: strategy.params },
    from: first.t, to: last.t, initialEquity: initial, finalEquity, trades, equity, signals, rejections,
    buyHoldPct: (last.c / first.o - 1) * 100,
    metrics: computeMetrics(equity, trades, initial, cfg.tf, end - start + 1),
  };
}
