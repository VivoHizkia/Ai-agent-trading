import { describe, expect, it } from "vitest";
import type { Candle, Intent, Manage, Position } from "../src/types.js";
import { marketSpec } from "../src/types.js";
import type { Strategy } from "../src/strategies/index.js";
import { runBacktest } from "../src/backtest/engine.js";
import { DEFAULT_RULES } from "../src/risk/engine.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2024, 0, 1);
const bar = (i: number, o: number, h: number, l: number, c: number): Candle => ({ t: T0 + i * DAY, o, h, l, c, v: 1 });
const flat = (n: number, px = 100) => Array.from({ length: n }, (_, i) => bar(i, px, px, px, px));

/** Strategi uji: kirim satu intent di bar tertentu, opsional manage. */
function scripted(at: number, intent: Intent, manage?: (i: number, p: Position) => Manage | null): Strategy {
  return {
    id: "test", params: {}, trailing: intent.target === undefined, warmup: 1,
    prepare() {},
    signal: i => (i === at ? intent : null),
    manage: (i, p) => (manage ? manage(i, p) : null),
  };
}

const spec = { ...marketSpec("TEST"), minNotional: 0, takerFee: 0, makerFee: 0, maintenanceMarginRate: 0.005 };
// Risk dipaku 1% supaya angka di tes tetap stabil walau DEFAULT_RULES (setelan live) diubah Bos.
const base = { symbol: "TEST", tf: "1d" as const, spec, slippage: 0, initialEquity: 10_000, defaultFundingRate: 0, rules: { ...DEFAULT_RULES, riskPct: 1 } };

describe("backtest engine", () => {
  it("entry di open bar berikutnya, bukan di close bar sinyal", () => {
    const c = flat(10);
    c[3] = bar(3, 100, 100, 100, 100);
    c[4] = bar(4, 105, 106, 104, 105);
    const r = runBacktest(c, scripted(3, { side: "long", stop: 90, target: 200, reason: "x" }), base);
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]!.entry).toBe(105);
    expect(r.trades[0]!.entryTime).toBe(c[4]!.t);
  });

  it("SL dan TP tersentuh di bar yang sama: dianggap SL (pesimis)", () => {
    const c = flat(10);
    c[5] = bar(5, 100, 130, 80, 100);
    const r = runBacktest(c, scripted(3, { side: "long", stop: 90, target: 120, reason: "x" }), base);
    expect(r.trades[0]!.exitReason).toBe("stop");
    expect(r.trades[0]!.exit).toBe(90);
    expect(r.trades[0]!.r).toBeCloseTo(-1, 6);
  });

  it("gap melewati stop dieksekusi di open, lebih buruk dari stop", () => {
    const c = flat(10);
    c[5] = bar(5, 85, 86, 84, 85);
    const r = runBacktest(c, scripted(3, { side: "long", stop: 90, target: 120, reason: "x" }), base);
    expect(r.trades[0]!.exit).toBe(85);
    expect(r.trades[0]!.r).toBeCloseTo(-1.5, 6);
  });

  it("entry dibatalkan kalau open sudah melewati stop", () => {
    const c = flat(10);
    c[4] = bar(4, 88, 89, 87, 88);
    const r = runBacktest(c, scripted(3, { side: "long", stop: 90, target: 120, reason: "x" }), base);
    expect(r.trades).toHaveLength(0);
    expect(r.rejections.gap_lewat_stop).toBe(1);
  });

  it("short: target kena memberi +2R", () => {
    const c = flat(10);
    c[5] = bar(5, 100, 101, 79, 80);
    const r = runBacktest(c, scripted(3, { side: "short", stop: 110, target: 80, reason: "x" }), base);
    expect(r.trades[0]!.exitReason).toBe("target");
    expect(r.trades[0]!.r).toBeCloseTo(2, 6);
  });

  it("size dari Risk Engine: rugi di stop = 1% equity", () => {
    const c = flat(10);
    c[5] = bar(5, 100, 100, 89, 95);
    const r = runBacktest(c, scripted(3, { side: "long", stop: 90, target: 120, reason: "x" }), base);
    expect(r.trades[0]!.pnl).toBeCloseTo(-100, 6);
    expect(r.finalEquity).toBeCloseTo(9_900, 6);
  });

  it("fee dihitung: taker di entry dan stop", () => {
    const c = flat(10);
    c[5] = bar(5, 100, 100, 89, 95);
    const r = runBacktest(c, scripted(3, { side: "long", stop: 90, target: 120, reason: "x" }), { ...base, spec: { ...spec, takerFee: 0.001 } });
    const t = r.trades[0]!; // qty = 100/10 = 10 → notional entry 1000, exit 900
    expect(t.fees).toBeCloseTo(1 + 0.9, 6);
    expect(t.pnl).toBeCloseTo(-100 - 1.9, 6);
  });

  it("funding: long membayar saat rate positif", () => {
    const c = flat(10);
    const funding = [{ t: c[5]!.t + 3_600_000, rate: 0.001 }, { t: c[6]!.t + 3_600_000, rate: 0.001 }];
    const r = runBacktest(c, scripted(3, { side: "long", stop: 90, target: 120, reason: "x" }), base, funding);
    const t = r.trades[0]!; // posisi 10 unit × 100 × 0.001 × 2 settlement = 2
    expect(t.funding).toBeCloseTo(-2, 6);
    expect(t.exitReason).toBe("end");
  });

  it("funding: short menerima saat rate positif", () => {
    const c = flat(10);
    const funding = [{ t: c[5]!.t + 3_600_000, rate: 0.001 }];
    const r = runBacktest(c, scripted(3, { side: "short", stop: 110, target: 80, reason: "x" }), base, funding);
    expect(r.trades[0]!.funding).toBeCloseTo(1, 6);
  });

  it("trailing stop hanya bisa mengetat, tidak melonggar", () => {
    const c = flat(12);
    for (let i = 4; i < 12; i++) c[i] = bar(i, 100 + (i - 4) * 5, 102 + (i - 4) * 5, 99 + (i - 4) * 5, 100 + (i - 4) * 5);
    c[10] = bar(10, 130, 131, 110, 112);
    const r = runBacktest(c, scripted(3, { side: "long", stop: 90, reason: "x" }, (i, p) => ({ newStop: i % 2 ? 50 : c[i]!.c - 8 })), base);
    expect(r.trades[0]!.exitReason).toBe("trailing");
    expect(r.trades[0]!.exit).toBe(112); // stop terakhir = close bar 8 (120) - 8; tawaran stop 50 diabaikan
  });

  it("exit sinyal dieksekusi di open bar berikutnya", () => {
    const c = flat(10);
    c[6] = bar(6, 103, 103, 103, 103);
    const r = runBacktest(c, scripted(3, { side: "long", stop: 90, reason: "x" }, i => (i === 5 ? { exit: true, reason: "keluar" } : null)), base);
    expect(r.trades[0]!.exitReason).toBe("signal");
    expect(r.trades[0]!.exit).toBe(103);
    expect(r.trades[0]!.exitTime).toBe(c[6]!.t);
  });

  it("likuidasi saat gap menembus harga likuidasi", () => {
    // stop dekat → size besar → leverage 5x → likuidasi ~ 80.5
    const c = flat(10);
    c[5] = bar(5, 70, 71, 69, 70);
    const r = runBacktest(c, scripted(3, { side: "long", stop: 99.9, target: 101, reason: "x" }),
      { ...base, rules: { riskPct: 1, maxLeverage: 5, minRR: 1, dailyLossPct: 3, maxOpenPositions: 2, maxStopToLiqFraction: 0.5 } });
    expect(r.trades[0]!.exitReason).toBe("liquidation");
    expect(r.trades[0]!.pnl).toBeCloseTo(-r.trades[0]!.qty * 100 / r.trades[0]!.leverage, 4);
  });

  it("batas rugi harian memblokir entry baru di hari yang sama", () => {
    const H = 3_600_000;
    const c: Candle[] = Array.from({ length: 12 }, (_, i) => ({ t: Date.UTC(2024, 0, 1, 0) + i * H, o: 100, h: 100, l: 100, c: 100, v: 1 }));
    c[3] = { ...c[3]!, l: 80, c: 85 }; // rugi besar di bar 3 (stop kena), sama hari WIB
    const strat: Strategy = {
      id: "t", params: {}, trailing: false, warmup: 1, prepare() {},
      signal: i => (i === 1 || i === 5 ? { side: "long", stop: 97, target: 110, reason: "x" } : null),
      manage: () => null,
    };
    const rules = { riskPct: 4, maxLeverage: 5, minRR: 2, dailyLossPct: 3, maxOpenPositions: 2, maxStopToLiqFraction: 0.9 };
    const r = runBacktest(c, strat, { ...base, tf: "1h", rules });
    expect(r.trades).toHaveLength(1);
    expect(r.rejections.batas_rugi_harian).toBe(1);
  });
});
