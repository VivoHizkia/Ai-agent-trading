// Indikator. Semua mengembalikan array sepanjang input; nilai sebelum cukup data = NaN.
// Nilai di index i hanya memakai data sampai i (tanpa look-ahead).
import type { Candle } from "./types.js";

export function sma(x: number[], n: number): number[] {
  const out = new Array(x.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < x.length; i++) {
    sum += x[i]!;
    if (i >= n) sum -= x[i - n]!;
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

export function ema(x: number[], n: number): number[] {
  const out = new Array(x.length).fill(NaN);
  const k = 2 / (n + 1);
  let prev = NaN;
  for (let i = 0; i < x.length; i++) {
    if (i === n - 1) {
      let s = 0;
      for (let j = 0; j < n; j++) s += x[j]!;
      prev = s / n;
    } else if (i >= n) {
      prev = x[i]! * k + prev * (1 - k);
    }
    if (i >= n - 1) out[i] = prev;
  }
  return out;
}

/** Wilder smoothing (RMA). */
export function rma(x: number[], n: number): number[] {
  const out = new Array(x.length).fill(NaN);
  let prev = NaN, count = 0, sum = 0, start = -1;
  for (let i = 0; i < x.length; i++) {
    const v = x[i]!;
    if (Number.isNaN(v)) continue;
    if (start < 0) start = i;
    if (count < n) {
      sum += v; count++;
      if (count === n) { prev = sum / n; out[i] = prev; }
    } else {
      prev = (prev * (n - 1) + v) / n;
      out[i] = prev;
    }
  }
  return out;
}

export function trueRange(c: Candle[]): number[] {
  return c.map((b, i) => (i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - c[i - 1]!.c), Math.abs(b.l - c[i - 1]!.c))));
}

export function atr(c: Candle[], n = 14): number[] {
  return rma(trueRange(c), n);
}

export function rsi(close: number[], n = 14): number[] {
  const gains = close.map((v, i) => (i === 0 ? NaN : Math.max(0, v - close[i - 1]!)));
  const losses = close.map((v, i) => (i === 0 ? NaN : Math.max(0, close[i - 1]! - v)));
  const g = rma(gains, n), l = rma(losses, n);
  return g.map((gv, i) => {
    const lv = l[i]!;
    if (Number.isNaN(gv) || Number.isNaN(lv)) return NaN;
    if (lv === 0) return gv === 0 ? 50 : 100;
    return 100 - 100 / (1 + gv / lv);
  });
}

/** ADX Wilder. Juga mengembalikan +DI dan -DI. */
export function adx(c: Candle[], n = 14): { adx: number[]; plusDI: number[]; minusDI: number[] } {
  const plusDM = c.map((b, i) => {
    if (i === 0) return NaN;
    const up = b.h - c[i - 1]!.h, down = c[i - 1]!.l - b.l;
    return up > down && up > 0 ? up : 0;
  });
  const minusDM = c.map((b, i) => {
    if (i === 0) return NaN;
    const up = b.h - c[i - 1]!.h, down = c[i - 1]!.l - b.l;
    return down > up && down > 0 ? down : 0;
  });
  const tr = trueRange(c).map((v, i) => (i === 0 ? NaN : v));
  const trS = rma(tr, n), pS = rma(plusDM, n), mS = rma(minusDM, n);
  const plusDI = trS.map((t, i) => (t ? (100 * pS[i]!) / t : NaN));
  const minusDI = trS.map((t, i) => (t ? (100 * mS[i]!) / t : NaN));
  const dx = plusDI.map((p, i) => {
    const m = minusDI[i]!;
    if (Number.isNaN(p) || Number.isNaN(m) || p + m === 0) return Number.isNaN(p) ? NaN : 0;
    return (100 * Math.abs(p - m)) / (p + m);
  });
  return { adx: rma(dx, n), plusDI, minusDI };
}

/** Highest high / lowest low dari n bar SEBELUM bar i (tidak termasuk bar i). */
export function donchian(c: Candle[], n: number): { upper: number[]; lower: number[] } {
  const upper = new Array(c.length).fill(NaN), lower = new Array(c.length).fill(NaN);
  for (let i = n; i < c.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - n; j < i; j++) { hi = Math.max(hi, c[j]!.h); lo = Math.min(lo, c[j]!.l); }
    upper[i] = hi; lower[i] = lo;
  }
  return { upper, lower };
}
