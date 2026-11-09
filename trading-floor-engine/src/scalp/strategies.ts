// Strategi scalping (5m / 15m) untuk RISET. Belum dipakai bot live.
// Semua strategi memakai target PERSEN HARGA tetap (param targetPct) dan stop = targetPct / rr (default rr 2,
// sesuai aturan Risk Engine minRR 2). Contoh: target 1% di leverage 20x = ROE +20%, stop 0.5% = ROE −10%.
// Ada batas waktu (maxBars): scalp yang tidak jalan ditutup supaya tidak berubah jadi swing.
import type { Candle } from "../types.js";
import type { StrategyDef } from "../strategies/index.js";
import { adx, atr, ema, rsi } from "../indicators.js";

const ok = (...xs: number[]) => xs.every(x => Number.isFinite(x));
const levels = (px: number, side: "long" | "short", p: Record<string, number>) => {
  const t = p.targetPct! / 100, s = t / p.rr!;
  return side === "long" ? { stop: px * (1 - s), target: px * (1 + t) } : { stop: px * (1 + s), target: px * (1 - t) };
};
const timeExit = (maxBars: number) => (i: number, pos: { entryIndex: number }) =>
  i - pos.entryIndex >= maxBars ? { exit: true, reason: `batas waktu ${maxBars} bar` } : null;

/** VWAP harian (reset 00:00 UTC). */
function dailyVwap(c: Candle[]): number[] {
  const out: number[] = [];
  let day = -1, pv = 0, vol = 0;
  for (const x of c) {
    const d = Math.floor(x.t / 86_400_000);
    if (d !== day) { day = d; pv = 0; vol = 0; }
    const tp = (x.h + x.l + x.c) / 3;
    pv += tp * x.v; vol += x.v;
    out.push(vol > 0 ? pv / vol : NaN);
  }
  return out;
}

/** Harga terlalu jauh dari VWAP saat pasar sideways → balik ke VWAP. */
const vwapRevert: StrategyDef = {
  id: "scalp_vwap",
  name: "VWAP mean reversion (sideways)",
  description: "Entry berlawanan saat harga menyimpang jauh dari VWAP harian, RSI ekstrem, dan ADX rendah.",
  defaults: { devPct: 0.8, rsiN: 7, band: 25, adxN: 14, adxMax: 22, targetPct: 1, rr: 2, maxBars: 36 },
  grid: { devPct: [0.6, 1.0], adxMax: [20, 25] },
  create(p) {
    let c: Candle[] = [], vw: number[] = [], r: number[] = [], ax: number[] = [];
    return {
      id: "scalp_vwap", params: p, trailing: false, warmup: 60,
      prepare(cs) { c = cs; vw = dailyVwap(cs); r = rsi(cs.map(x => x.c), p.rsiN!); ax = adx(cs, p.adxN!).adx; },
      signal(i) {
        const px = c[i]!.c;
        if (!ok(vw[i]!, r[i]!, ax[i]!) || ax[i]! >= p.adxMax!) return null;
        const dev = (px / vw[i]! - 1) * 100;
        if (dev <= -p.devPct! && r[i]! <= p.band!) return { side: "long", ...levels(px, "long", p), reason: `${dev.toFixed(2)}% di bawah VWAP, RSI ${r[i]!.toFixed(0)}` };
        if (dev >= p.devPct! && r[i]! >= 100 - p.band!) return { side: "short", ...levels(px, "short", p), reason: `+${dev.toFixed(2)}% di atas VWAP, RSI ${r[i]!.toFixed(0)}` };
        return null;
      },
      manage: timeExit(p.maxBars!),
    };
  },
};

/** Range sempit lalu jebol, searah EMA200. */
const rangeBreak: StrategyDef = {
  id: "scalp_break",
  name: "Breakout range sempit",
  description: "Harga keluar dari range N bar yang sempit, searah EMA200.",
  defaults: { n: 24, maxWidthPct: 1.5, trendN: 200, targetPct: 1, rr: 2, maxBars: 36 },
  grid: { n: [24, 48], maxWidthPct: [1, 2] },
  create(p) {
    let c: Candle[] = [], tr: number[] = [];
    return {
      id: "scalp_break", params: p, trailing: false, warmup: Math.max(p.trendN!, p.n!) + 2,
      prepare(cs) { c = cs; tr = ema(cs.map(x => x.c), p.trendN!); },
      signal(i) {
        if (i <= p.n! || !ok(tr[i]!)) return null;
        let hi = -Infinity, lo = Infinity;
        for (let k = i - p.n!; k < i; k++) { hi = Math.max(hi, c[k]!.h); lo = Math.min(lo, c[k]!.l); }
        const width = (hi / lo - 1) * 100, px = c[i]!.c;
        if (width > p.maxWidthPct!) return null;
        if (px > hi && px > tr[i]!) return { side: "long", ...levels(px, "long", p), reason: `Jebol range ${width.toFixed(2)}% ke atas` };
        if (px < lo && px < tr[i]!) return { side: "short", ...levels(px, "short", p), reason: `Jebol range ${width.toFixed(2)}% ke bawah` };
        return null;
      },
      manage: timeExit(p.maxBars!),
    };
  },
};

/** RSI cepat keluar dari zona ekstrem saat ADX rendah (versi cepat rsi_range). */
const rsiFast: StrategyDef = {
  id: "scalp_rsi",
  name: "RSI cepat (sideways)",
  description: "RSI(7) keluar dari oversold/overbought saat ADX rendah.",
  defaults: { rsiN: 7, band: 20, adxN: 14, adxMax: 22, targetPct: 1, rr: 2, maxBars: 36 },
  grid: { band: [15, 20], adxMax: [20, 25] },
  create(p) {
    let c: Candle[] = [], r: number[] = [], ax: number[] = [], a: number[] = [];
    return {
      id: "scalp_rsi", params: p, trailing: false, warmup: 60,
      prepare(cs) { c = cs; r = rsi(cs.map(x => x.c), p.rsiN!); ax = adx(cs, p.adxN!).adx; a = atr(cs, 14); },
      signal(i) {
        const px = c[i]!.c, lo = p.band!, hi = 100 - p.band!;
        if (!ok(r[i]!, r[i - 1]!, ax[i]!, a[i]!) || ax[i]! >= p.adxMax!) return null;
        if (r[i - 1]! < lo && r[i]! >= lo) return { side: "long", ...levels(px, "long", p), reason: `RSI keluar oversold, ADX ${ax[i]!.toFixed(0)}` };
        if (r[i - 1]! > hi && r[i]! <= hi) return { side: "short", ...levels(px, "short", p), reason: `RSI keluar overbought, ADX ${ax[i]!.toFixed(0)}` };
        return null;
      },
      manage: timeExit(p.maxBars!),
    };
  },
};

/** Versi "jam ramai": hanya boleh entry 14:00–23:00 WIB (07:00–16:00 UTC, sesi Eropa + AS). */
export const SESSION_UTC = [7, 16] as const;
function withSession(def: StrategyDef): StrategyDef {
  return {
    ...def, id: `${def.id}_sesi`, name: `${def.name} · jam ramai`,
    description: `${def.description} Hanya entry 14:00–23:00 WIB.`,
    create(p) {
      const s = def.create(p);
      let cs: Candle[] = [];
      return {
        ...s, id: `${def.id}_sesi`,
        prepare(x) { cs = x; s.prepare(x); },
        signal(i) {
          const h = new Date(cs[i]!.t).getUTCHours();
          return h >= SESSION_UTC[0] && h < SESSION_UTC[1] ? s.signal(i) : null;
        },
        manage: (i, pos) => s.manage(i, pos),
      };
    },
  };
}

const BASE = [vwapRevert, rangeBreak, rsiFast];
/** SCALP_SESSION=both (default) uji tanpa & dengan filter jam, =only hanya versi jam ramai, =off tanpa filter. */
const MODE = process.env.SCALP_SESSION ?? "both";
export const SCALP_STRATEGIES: StrategyDef[] =
  MODE === "only" ? BASE.map(withSession) : MODE === "off" ? BASE : [...BASE, ...BASE.map(withSession)];
