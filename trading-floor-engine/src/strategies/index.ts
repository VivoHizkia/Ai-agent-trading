// Strategi rule-based. Semua keputusan di close bar i, hanya memakai data sampai i.
// Engine yang mengeksekusi di open bar i+1, dan Risk Engine yang menentukan size.
import type { Candle, Intent, Manage, Position } from "../types.js";
import { adx, atr, donchian, ema, rsi, sma } from "../indicators.js";

export type Params = Record<string, number>;

export interface Strategy {
  id: string;
  params: Params;
  trailing: boolean; // tanpa target tetap
  warmup: number;
  prepare(candles: Candle[]): void;
  signal(i: number): Intent | null;
  manage(i: number, pos: Position): Manage | null;
}

export interface StrategyDef {
  id: string;
  name: string;
  description: string;
  defaults: Params;
  /** Grid kecil untuk walk-forward. Sengaja sedikit supaya tidak curve-fit. */
  grid: Record<string, number[]>;
  create(params: Params): Strategy;
}

const allow = (dir: number, side: "long" | "short") => dir === 0 || (dir === 1 ? side === "long" : side === "short");
const crossUp = (a: number[], b: number[], i: number) => a[i - 1]! <= b[i - 1]! && a[i]! > b[i]!;
const crossDown = (a: number[], b: number[], i: number) => a[i - 1]! >= b[i - 1]! && a[i]! < b[i]!;
const ok = (...xs: number[]) => xs.every(x => Number.isFinite(x));

/** Baseline: strategi yang sudah dites di TextToQuant (grade F). Dipakai sebagai pembanding. */
const emaTrend: StrategyDef = {
  id: "ema_trend",
  name: "EMA cross + filter EMA200 (baseline)",
  description: "EMA20/50 cross searah EMA200, SL dan TP persen tetap. Sama dengan backtest 23 Okt.",
  defaults: { fast: 20, slow: 50, filter: 200, stopPct: 3, targetPct: 9, dir: 0 },
  grid: { stopPct: [2, 3, 4], targetPct: [6, 9, 12] },
  create(p) {
    let c: Candle[] = [], f: number[] = [], s: number[] = [], flt: number[] = [];
    return {
      id: "ema_trend", params: p, trailing: false, warmup: p.filter! + 2,
      prepare(cs) { c = cs; const cl = cs.map(x => x.c); f = ema(cl, p.fast!); s = ema(cl, p.slow!); flt = ema(cl, p.filter!); },
      signal(i) {
        const px = c[i]!.c;
        if (!ok(f[i]!, s[i]!, flt[i]!, f[i - 1]!, s[i - 1]!)) return null;
        if (allow(p.dir!, "long") && crossUp(f, s, i) && px > flt[i]!)
          return { side: "long", stop: px * (1 - p.stopPct! / 100), target: px * (1 + p.targetPct! / 100), reason: "EMA cross naik di atas EMA200" };
        if (allow(p.dir!, "short") && crossDown(f, s, i) && px < flt[i]!)
          return { side: "short", stop: px * (1 + p.stopPct! / 100), target: px * (1 - p.targetPct! / 100), reason: "EMA cross turun di bawah EMA200" };
        return null;
      },
      manage() { return null; },
    };
  },
};

/** Breakout Donchian dengan filter tren + chandelier trailing stop berbasis ATR. */
const donchianBreakout: StrategyDef = {
  id: "donchian",
  name: "Donchian breakout + ATR trailing",
  description: "Masuk saat tembus high/low N bar searah EMA200; stop awal ATR, trailing chandelier, keluar di channel pendek.",
  defaults: { n: 20, exitN: 10, atrN: 14, atrMult: 2.5, filter: 200, dir: 0 },
  grid: { n: [20, 40, 55], atrMult: [2, 3] },
  create(p) {
    let c: Candle[] = [], up: number[] = [], lo: number[] = [], exUp: number[] = [], exLo: number[] = [], a: number[] = [], flt: number[] = [];
    return {
      id: "donchian", params: p, trailing: true, warmup: Math.max(p.filter!, p.n!) + 2,
      prepare(cs) {
        c = cs; const d = donchian(cs, p.n!); up = d.upper; lo = d.lower;
        const e = donchian(cs, p.exitN!); exUp = e.upper; exLo = e.lower;
        a = atr(cs, p.atrN!); flt = ema(cs.map(x => x.c), p.filter!);
      },
      signal(i) {
        const px = c[i]!.c;
        if (!ok(up[i]!, lo[i]!, a[i]!, flt[i]!)) return null;
        if (allow(p.dir!, "long") && px > up[i]! && px > flt[i]!)
          return { side: "long", stop: px - p.atrMult! * a[i]!, reason: `Tembus high ${p.n} bar di atas EMA200` };
        if (allow(p.dir!, "short") && px < lo[i]! && px < flt[i]!)
          return { side: "short", stop: px + p.atrMult! * a[i]!, reason: `Tembus low ${p.n} bar di bawah EMA200` };
        return null;
      },
      manage(i, pos) {
        const px = c[i]!.c;
        if (pos.side === "long") {
          if (px < exLo[i]!) return { exit: true, reason: `Close di bawah low ${p.exitN} bar` };
          let hi = -Infinity; for (let j = pos.entryIndex; j <= i; j++) hi = Math.max(hi, c[j]!.c);
          return { newStop: hi - p.atrMult! * a[i]! };
        }
        if (px > exUp[i]!) return { exit: true, reason: `Close di atas high ${p.exitN} bar` };
        let lw = Infinity; for (let j = pos.entryIndex; j <= i; j++) lw = Math.min(lw, c[j]!.c);
        return { newStop: lw + p.atrMult! * a[i]! };
      },
    };
  },
};

/** EMA cross, tapi hanya saat tren kuat (ADX) — menjawab kelemahan baseline di pasar chop. */
const emaAdx: StrategyDef = {
  id: "ema_adx",
  name: "EMA cross + filter ADX",
  description: "Seperti baseline, tapi hanya entry saat ADX di atas ambang; stop ATR, target R tetap, stop ke breakeven di +1R.",
  defaults: { fast: 20, slow: 50, filter: 200, adxN: 14, adxMin: 25, atrN: 14, atrMult: 2, rr: 2.5, dir: 0 },
  grid: { adxMin: [20, 25, 30], atrMult: [1.5, 2, 3] },
  create(p) {
    let c: Candle[] = [], f: number[] = [], s: number[] = [], flt: number[] = [], ax: number[] = [], a: number[] = [];
    return {
      id: "ema_adx", params: p, trailing: false, warmup: p.filter! + 2,
      prepare(cs) {
        c = cs; const cl = cs.map(x => x.c);
        f = ema(cl, p.fast!); s = ema(cl, p.slow!); flt = ema(cl, p.filter!);
        ax = adx(cs, p.adxN!).adx; a = atr(cs, p.atrN!);
      },
      signal(i) {
        const px = c[i]!.c;
        if (!ok(f[i]!, s[i]!, flt[i]!, ax[i]!, a[i]!, f[i - 1]!, s[i - 1]!) || ax[i]! < p.adxMin!) return null;
        const r = p.atrMult! * a[i]!;
        if (allow(p.dir!, "long") && crossUp(f, s, i) && px > flt[i]!)
          return { side: "long", stop: px - r, target: px + p.rr! * r, reason: `EMA cross naik, ADX ${ax[i]!.toFixed(0)}` };
        if (allow(p.dir!, "short") && crossDown(f, s, i) && px < flt[i]!)
          return { side: "short", stop: px + r, target: px - p.rr! * r, reason: `EMA cross turun, ADX ${ax[i]!.toFixed(0)}` };
        return null;
      },
      manage(i, pos) {
        const R = Math.abs(pos.entry - pos.initialStop), px = c[i]!.c;
        if (pos.side === "long" && px >= pos.entry + R) return { newStop: pos.entry, reason: "breakeven di +1R" };
        if (pos.side === "short" && px <= pos.entry - R) return { newStop: pos.entry, reason: "breakeven di +1R" };
        return null;
      },
    };
  },
};

/** Mean reversion RSI, HANYA saat pasar range (ADX rendah). Kebalikan dari strategi tren. */
const rsiRange: StrategyDef = {
  id: "rsi_range",
  name: "RSI mean reversion di pasar range",
  description: "Beli saat RSI keluar dari oversold / jual saat keluar dari overbought, hanya kalau ADX rendah; keluar kalau tren mulai.",
  defaults: { rsiN: 14, band: 30, adxN: 14, adxMax: 20, atrN: 14, atrMult: 1.5, rr: 2, dir: 0 },
  grid: { band: [25, 30], adxMax: [20, 25] },
  create(p) {
    let c: Candle[] = [], r: number[] = [], ax: number[] = [], a: number[] = [];
    return {
      id: "rsi_range", params: p, trailing: false, warmup: 60,
      prepare(cs) { c = cs; r = rsi(cs.map(x => x.c), p.rsiN!); ax = adx(cs, p.adxN!).adx; a = atr(cs, p.atrN!); },
      signal(i) {
        const px = c[i]!.c, lo = p.band!, hi = 100 - p.band!;
        if (!ok(r[i]!, r[i - 1]!, ax[i]!, a[i]!) || ax[i]! >= p.adxMax!) return null;
        const d = p.atrMult! * a[i]!;
        if (allow(p.dir!, "long") && r[i - 1]! < lo && r[i]! >= lo)
          return { side: "long", stop: px - d, target: px + p.rr! * d, reason: `RSI keluar dari oversold, ADX ${ax[i]!.toFixed(0)}` };
        if (allow(p.dir!, "short") && r[i - 1]! > hi && r[i]! <= hi)
          return { side: "short", stop: px + d, target: px - p.rr! * d, reason: `RSI keluar dari overbought, ADX ${ax[i]!.toFixed(0)}` };
        return null;
      },
      manage(i) {
        if (ax[i]! > p.adxMax! + 10) return { exit: true, reason: "ADX naik, range selesai" };
        return null;
      },
    };
  },
};

/** Long-only ikut tren besar dengan trailing ATR. Alternatif "hold dengan rem". */
const trendLong: StrategyDef = {
  id: "trend_long",
  name: "Long-only tren + ATR trailing",
  description: "Long saat harga di atas EMA cepat dan EMA cepat di atas EMA200; trailing chandelier; keluar di bawah EMA200.",
  defaults: { fast: 50, slow: 200, atrN: 14, atrMult: 3, breakoutN: 20, dir: 1 },
  grid: { fast: [20, 50], atrMult: [2.5, 3.5] },
  create(p) {
    let c: Candle[] = [], f: number[] = [], s: number[] = [], a: number[] = [], up: number[] = [];
    const regime = (i: number) => c[i]!.c > f[i]! && f[i]! > s[i]!;
    return {
      id: "trend_long", params: p, trailing: true, warmup: p.slow! + 2,
      prepare(cs) { c = cs; const cl = cs.map(x => x.c); f = ema(cl, p.fast!); s = ema(cl, p.slow!); a = atr(cs, p.atrN!); up = donchian(cs, p.breakoutN!).upper; },
      signal(i) {
        if (!ok(f[i]!, s[i]!, a[i]!, f[i - 1]!, s[i - 1]!, up[i]!)) return null;
        if (!regime(i)) return null;
        const fresh = !regime(i - 1);
        if (fresh || c[i]!.c > up[i]!)
          return { side: "long", stop: c[i]!.c - p.atrMult! * a[i]!, reason: fresh ? "Rezim tren naik dimulai" : `High baru ${p.breakoutN} bar dalam tren naik` };
        return null;
      },
      manage(i, pos) {
        if (c[i]!.c < s[i]!) return { exit: true, reason: "Close di bawah EMA200" };
        let hi = -Infinity; for (let j = pos.entryIndex; j <= i; j++) hi = Math.max(hi, c[j]!.c);
        return { newStop: hi - p.atrMult! * a[i]! };
      },
    };
  },
};

/** Pullback ke EMA cepat di dalam tren: masuk lebih awal dari breakout, dengan stop lebih dekat. */
const pullback: StrategyDef = {
  id: "pullback",
  name: "Pullback ke EMA20 dalam tren",
  description: "Tren: EMA50 di atas EMA200 dan harga di atas EMA200. Masuk saat harga menyentuh EMA20 lalu close kembali searah tren dengan candle searah; stop ATR, target R tetap.",
  defaults: { fast: 20, mid: 50, filter: 200, atrN: 14, atrMult: 1.5, rr: 2.5, dir: 0 },
  grid: { atrMult: [1.5, 2], rr: [2, 3] },
  create(p) {
    let c: Candle[] = [], f: number[] = [], m: number[] = [], flt: number[] = [], a: number[] = [];
    return {
      id: "pullback", params: p, trailing: false, warmup: p.filter! + 2,
      prepare(cs) { c = cs; const cl = cs.map(x => x.c); f = ema(cl, p.fast!); m = ema(cl, p.mid!); flt = ema(cl, p.filter!); a = atr(cs, p.atrN!); },
      signal(i) {
        const b = c[i]!, px = b.c;
        if (!ok(f[i]!, m[i]!, flt[i]!, a[i]!)) return null;
        const r = p.atrMult! * a[i]!;
        if (allow(p.dir!, "long") && m[i]! > flt[i]! && px > flt[i]! && b.l <= f[i]! && px > f[i]! && px > b.o)
          return { side: "long", stop: px - r, target: px + p.rr! * r, reason: `Pullback ke EMA${p.fast} dalam tren naik` };
        if (allow(p.dir!, "short") && m[i]! < flt[i]! && px < flt[i]! && b.h >= f[i]! && px < f[i]! && px < b.o)
          return { side: "short", stop: px + r, target: px - p.rr! * r, reason: `Pullback ke EMA${p.fast} dalam tren turun` };
        return null;
      },
      manage() { return null; },
    };
  },
};

/** Breakout Donchian yang hanya diambil kalau volumenya jauh di atas rata-rata (breakout "sungguhan"). */
const volumeBreakout: StrategyDef = {
  id: "vol_breakout",
  name: "Breakout + konfirmasi volume",
  description: "Tembus high/low N bar searah EMA200 dengan volume di atas volMult x rata-rata 20 bar; stop ATR, trailing chandelier, keluar di channel pendek.",
  defaults: { n: 20, exitN: 10, volN: 20, volMult: 1.5, atrN: 14, atrMult: 2.5, filter: 200, dir: 0 },
  grid: { n: [20, 40], volMult: [1.5, 2] },
  create(p) {
    let c: Candle[] = [], up: number[] = [], lo: number[] = [], exUp: number[] = [], exLo: number[] = [], a: number[] = [], flt: number[] = [], vAvg: number[] = [];
    return {
      id: "vol_breakout", params: p, trailing: true, warmup: Math.max(p.filter!, p.n!, p.volN!) + 2,
      prepare(cs) {
        c = cs; const d = donchian(cs, p.n!); up = d.upper; lo = d.lower;
        const e = donchian(cs, p.exitN!); exUp = e.upper; exLo = e.lower;
        a = atr(cs, p.atrN!); flt = ema(cs.map(x => x.c), p.filter!);
        // Rata-rata volume bar SEBELUM bar i, supaya volume breakout tidak ikut menaikkan pembandingnya sendiri.
        const v = sma(cs.map(x => x.v), p.volN!); vAvg = [NaN, ...v.slice(0, -1)];
      },
      signal(i) {
        const b = c[i]!, px = b.c;
        if (!ok(up[i]!, lo[i]!, a[i]!, flt[i]!, vAvg[i]!) || !(b.v > p.volMult! * vAvg[i]!)) return null;
        if (allow(p.dir!, "long") && px > up[i]! && px > flt[i]!)
          return { side: "long", stop: px - p.atrMult! * a[i]!, reason: `Tembus high ${p.n} bar, volume ${(b.v / vAvg[i]!).toFixed(1)}x rata-rata` };
        if (allow(p.dir!, "short") && px < lo[i]! && px < flt[i]!)
          return { side: "short", stop: px + p.atrMult! * a[i]!, reason: `Tembus low ${p.n} bar, volume ${(b.v / vAvg[i]!).toFixed(1)}x rata-rata` };
        return null;
      },
      manage(i, pos) {
        const px = c[i]!.c;
        if (pos.side === "long") {
          if (px < exLo[i]!) return { exit: true, reason: `Close di bawah low ${p.exitN} bar` };
          let hi = -Infinity; for (let j = pos.entryIndex; j <= i; j++) hi = Math.max(hi, c[j]!.c);
          return { newStop: hi - p.atrMult! * a[i]! };
        }
        if (px > exUp[i]!) return { exit: true, reason: `Close di atas high ${p.exitN} bar` };
        let lw = Infinity; for (let j = pos.entryIndex; j <= i; j++) lw = Math.min(lw, c[j]!.c);
        return { newStop: lw + p.atrMult! * a[i]! };
      },
    };
  },
};

/** Squeeze volatilitas: Bollinger paling sempit dalam L bar, lalu close keluar dari band searah EMA200. */
const squeeze: StrategyDef = {
  id: "squeeze",
  name: "Bollinger squeeze breakout",
  description: "Lebar Bollinger(20,2) mencapai titik tersempit L bar dalam 5 bar terakhir, lalu close menembus band searah EMA200; stop ATR, trailing chandelier, keluar kalau close kembali melewati garis tengah.",
  defaults: { bbN: 20, bbK: 2, lookback: 120, recent: 5, atrN: 14, atrMult: 2, filter: 200, dir: 0 },
  grid: { lookback: [60, 120], atrMult: [2, 3] },
  create(p) {
    let c: Candle[] = [], mid: number[] = [], upB: number[] = [], loB: number[] = [], squeezed: boolean[] = [], a: number[] = [], flt: number[] = [];
    return {
      id: "squeeze", params: p, trailing: true, warmup: Math.max(p.filter!, p.lookback! + p.bbN!) + 2,
      prepare(cs) {
        c = cs; const cl = cs.map(x => x.c);
        mid = sma(cl, p.bbN!); a = atr(cs, p.atrN!); flt = ema(cl, p.filter!);
        const n = p.bbN!, bw: number[] = new Array(cs.length).fill(NaN);
        upB = new Array(cs.length).fill(NaN); loB = new Array(cs.length).fill(NaN);
        for (let i = n - 1; i < cs.length; i++) {
          let s2 = 0; for (let j = i - n + 1; j <= i; j++) s2 += (cl[j]! - mid[i]!) ** 2;
          const sd = Math.sqrt(s2 / n);
          upB[i] = mid[i]! + p.bbK! * sd; loB[i] = mid[i]! - p.bbK! * sd; bw[i] = (upB[i]! - loB[i]!) / mid[i]!;
        }
        // squeezed[i]: lebar band di bar i adalah yang tersempit dalam `lookback` bar terakhir (termasuk i).
        squeezed = bw.map((x, i) => {
          if (!Number.isFinite(x) || i < p.lookback!) return false;
          for (let j = i - p.lookback! + 1; j < i; j++) if (bw[j]! < x) return false;
          return true;
        });
      },
      signal(i) {
        const px = c[i]!.c;
        if (!ok(mid[i]!, upB[i]!, loB[i]!, a[i]!, flt[i]!)) return null;
        let recent = false; for (let j = Math.max(0, i - p.recent!); j < i && !recent; j++) recent = squeezed[j]!;
        if (!recent) return null;
        if (allow(p.dir!, "long") && px > upB[i]! && px > flt[i]!)
          return { side: "long", stop: px - p.atrMult! * a[i]!, reason: "Keluar dari squeeze ke atas" };
        if (allow(p.dir!, "short") && px < loB[i]! && px < flt[i]!)
          return { side: "short", stop: px + p.atrMult! * a[i]!, reason: "Keluar dari squeeze ke bawah" };
        return null;
      },
      manage(i, pos) {
        const px = c[i]!.c;
        if (pos.side === "long") {
          if (px < mid[i]!) return { exit: true, reason: `Close di bawah SMA${p.bbN}` };
          let hi = -Infinity; for (let j = pos.entryIndex; j <= i; j++) hi = Math.max(hi, c[j]!.c);
          return { newStop: hi - p.atrMult! * a[i]! };
        }
        if (px > mid[i]!) return { exit: true, reason: `Close di atas SMA${p.bbN}` };
        let lw = Infinity; for (let j = pos.entryIndex; j <= i; j++) lw = Math.min(lw, c[j]!.c);
        return { newStop: lw + p.atrMult! * a[i]! };
      },
    };
  },
};

// Diuji 30 Okt 2026 dan DIHAPUS: bb_revert (kembali ke dalam Bollinger saat ADX rendah) dan channel_fade (fade batas
// kisaran N bar saat ADX rendah). Top 84 koin, walk-forward: rata-rata semua koin -0.07R/-0.08R (4h) dan -0.12R/-0.14R
// (1h) walau win rate 44-59%; 1 lolos dari 336 kombinasi (BULLA 1h, data 4 bulan). Jangan dicoba ulang tanpa ide baru.

export const STRATEGIES: StrategyDef[] = [emaTrend, donchianBreakout, emaAdx, rsiRange, trendLong, pullback, volumeBreakout, squeeze];

export function getStrategy(id: string): StrategyDef {
  const s = STRATEGIES.find(x => x.id === id);
  if (!s) throw new Error(`Strategi '${id}' tidak ada. Pilihan: ${STRATEGIES.map(x => x.id).join(", ")}`);
  return s;
}

export function gridCombos(grid: Record<string, number[]>): Params[] {
  return Object.entries(grid).reduce<Params[]>(
    (acc, [k, vals]) => acc.flatMap(a => vals.map(v => ({ ...a, [k]: v }))),
    [{}],
  );
}
