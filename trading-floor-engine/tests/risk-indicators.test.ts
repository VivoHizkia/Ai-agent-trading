import { describe, expect, it } from "vitest";
import { DEFAULT_RULES, evaluateRisk, liquidationPrice } from "../src/risk/engine.js";
import { marketSpec } from "../src/types.js";
import { atr, donchian, ema, rsi, sma, adx } from "../src/indicators.js";
import { syntheticCandles } from "../src/data/synthetic.js";
import { monteCarlo } from "../src/backtest/montecarlo.js";

const btc = marketSpec("BTCUSDT");
// Risk dipaku 1% supaya angka di tes tetap stabil walau DEFAULT_RULES (setelan live) diubah Bos.
const rules = { ...DEFAULT_RULES, riskPct: 1 };
const base = { refPrice: 100, equity: 10_000, dayStartEquity: 10_000, dayPnl: 0, openPositions: 0, spec: { ...btc, minNotional: 0 }, trailingExit: false, rules };

describe("risk engine", () => {
  it("size = 1% equity / jarak stop", () => {
    const d = evaluateRisk({ ...base, intent: { side: "long", stop: 95, target: 110, reason: "" } });
    expect(d.ok).toBe(true);
    expect(d.qty).toBeCloseTo(20, 9);
    expect(d.riskUsd).toBeCloseTo(100, 9);
    expect(d.leverage).toBe(1);
  });
  it("tanpa stop ditolak", () => {
    const d = evaluateRisk({ ...base, intent: { side: "long", stop: NaN, target: 110, reason: "" } });
    expect(d.rejections).toContain("tanpa_stop");
  });
  it("stop di sisi salah ditolak", () => {
    expect(evaluateRisk({ ...base, intent: { side: "short", stop: 95, target: 80, reason: "" } }).rejections).toContain("stop_salah_sisi");
  });
  it("R:R di bawah 2 ditolak", () => {
    expect(evaluateRisk({ ...base, intent: { side: "long", stop: 95, target: 105, reason: "" } }).rejections).toContain("rr_kurang");
  });
  it("tanpa target hanya boleh untuk strategi trailing", () => {
    expect(evaluateRisk({ ...base, intent: { side: "long", stop: 95, reason: "" } }).rejections).toContain("tanpa_target");
    expect(evaluateRisk({ ...base, trailingExit: true, intent: { side: "long", stop: 95, reason: "" } }).ok).toBe(true);
  });
  it("leverage dibatasi 5x dan size dikurangi", () => {
    const d = evaluateRisk({ ...base, intent: { side: "long", stop: 99.9, target: 110, reason: "" }, rules: { riskPct: 1, maxLeverage: 5, minRR: 2, dailyLossPct: 3, maxOpenPositions: 2, maxStopToLiqFraction: 0.5 } });
    expect(d.leverage).toBe(5);
    expect(d.notional).toBeLessThanOrEqual(50_000);
    expect(d.riskUsd).toBeLessThan(100);
  });
  it("margin satu posisi muat di jatahnya, jadi maksimal posisi bisa terbuka bersamaan", () => {
    // Kasus ZECUSDT 24 Okt: risk 10%, equity $29.4 — posisi pertama dulu memakan hampir semua margin.
    const r = { ...DEFAULT_RULES, riskPct: 10, maxOpenPositions: 2, marginSlots: undefined };
    const d = evaluateRisk({ ...base, equity: 29.4, dayStartEquity: 29.4, refPrice: 100, intent: { side: "short", stop: 104, target: 92, reason: "" }, rules: r });
    expect(d.margin * r.maxOpenPositions).toBeLessThanOrEqual(29.4 * 0.9 + 1e-9);
    expect(d.riskUsd).toBeCloseTo(2.94, 2);
  });
  // Altcoin (spec default, maintenance margin 1%), bukan BTC: di sinilah jatah margin kecil memaksa leverage terlalu tinggi.
  const alt = { ...marketSpec("ZECUSDT"), minNotional: 0 };
  const live = (riskPct: number, stopPct: number) => evaluateRisk({
    ...base, spec: alt, equity: 99.5, dayStartEquity: 99.5, refPrice: 100,
    intent: { side: "long", stop: 100 - stopPct, target: 100 + 3 * stopPct, reason: "" }, rules: { ...DEFAULT_RULES, riskPct },
  });

  it("risk 5% (1h), stop 2%: margin muat di jatah 4 posisi", () => {
    const d = live(5, 2);
    expect(d.ok).toBe(true);
    expect(d.margin * 4).toBeLessThanOrEqual(99.5 * 0.9 + 1e-9);
    expect(d.riskUsd).toBeCloseTo(4.975, 2);
  });

  it("risk 10%, stop 2–8% di altcoin: tidak pernah ditolak karena likuidasi (regresi 26 Okt)", () => {
    for (const stopPct of [2, 3, 4, 5, 6, 8]) {
      const d = live(10, stopPct);
      expect(d.rejections, `stop ${stopPct}%`).not.toContain("stop_terlalu_dekat_likuidasi");
      expect(d.ok, `stop ${stopPct}%`).toBe(true);
      expect(d.riskUsd).toBeCloseTo(9.95, 2);
      // Kalau jatah 4 posisi tidak aman, margin boleh membesar, tapi tidak melebihi jatah 2 posisi (aturan lama).
      expect(d.margin).toBeLessThanOrEqual((99.5 * 0.9) / 2 + 1e-9);
    }
  });
  it("min notional: $81 equity, stop 3% di BTC ditolak", () => {
    const d = evaluateRisk({ ...base, equity: 81.01, dayStartEquity: 81.01, spec: btc, intent: { side: "long", stop: 97, target: 106, reason: "" } });
    expect(d.notional).toBeCloseTo(27, 0);
    expect(d.rejections).toContain("di_bawah_min_notional");
  });
  it("batas rugi harian", () => {
    expect(evaluateRisk({ ...base, dayPnl: -300, intent: { side: "long", stop: 95, target: 110, reason: "" } }).rejections).toContain("batas_rugi_harian");
  });
  it("harga likuidasi isolated", () => {
    expect(liquidationPrice("long", 100, 5, 0.004)).toBeCloseTo(80.4, 9);
    expect(liquidationPrice("short", 100, 5, 0.004)).toBeCloseTo(119.6, 9);
  });
});

describe("indikator", () => {
  it("SMA/EMA dari deret konstan = konstanta", () => {
    const x = Array(50).fill(7);
    expect(sma(x, 10)[49]).toBe(7);
    expect(ema(x, 10)[49]).toBeCloseTo(7, 12);
    expect(Number.isNaN(ema(x, 10)[8])).toBe(true);
  });
  it("RSI di rentang 0–100 dan 100 saat naik terus", () => {
    const up = Array.from({ length: 40 }, (_, i) => 100 + i);
    expect(rsi(up, 14)[39]).toBe(100);
    const c = syntheticCandles({ bars: 300, tf: "1d", seed: 3 });
    for (const v of rsi(c.map(x => x.c), 14).filter(Number.isFinite)) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(100); }
  });
  it("ATR positif, ADX di rentang 0–100", () => {
    const c = syntheticCandles({ bars: 300, tf: "1d", seed: 5 });
    expect(atr(c, 14)[299]).toBeGreaterThan(0);
    for (const v of adx(c, 14).adx.filter(Number.isFinite)) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(100); }
  });
  it("Donchian tidak memakai bar saat ini", () => {
    const c = syntheticCandles({ bars: 50, tf: "1d", seed: 9 });
    c[30] = { ...c[30]!, h: 1e9 };
    expect(donchian(c, 10).upper[30]).toBeLessThan(1e9);
    expect(donchian(c, 10).upper[31]).toBe(1e9);
  });
});

describe("monte carlo", () => {
  it("deterministik dengan seed sama, null untuk sampel kecil", () => {
    const rs = [2, -1, -1, 3, -1, 0.5, -1, 2];
    expect(monteCarlo(rs, 1, 500, 3)).toEqual(monteCarlo(rs, 1, 500, 3));
    expect(monteCarlo([1, 2], 1)).toBeNull();
  });
});
