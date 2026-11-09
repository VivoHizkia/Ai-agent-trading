import { describe, expect, it } from "vitest";
import { liveCheck, liveReportText, type Expectations } from "../src/ops/livecheck.js";
import type { TradeRecord } from "../src/ops/common.js";

const exp: Expectations = {
  createdAt: new Date().toISOString(),
  rows: { "ZECUSDT 4h ema_trend": { trades: 133, winRate: 0.34, avgR: 0.5, sdR: 1.5, from: "2021-01-01" } },
};
const trade = (r: number, symbol = "ZECUSDT"): TradeRecord => ({
  t: new Date().toISOString(), mode: "live", symbol, tf: "4h", strategyId: "ema_trend", side: "long",
  entry: 1, exit: 1, pnl: r * 10, r, reason: "test",
});
// Pola menang 1 (+3R) kalah 2 (−1R): rata-rata +0.33R, dekat backtest +0.5R.
const normal = (n: number) => Array.from({ length: n }, (_, i) => trade(i % 3 === 0 ? 3 : -1));

describe("live vs backtest", () => {
  it("tanpa file pembanding: status tanpa pembanding", () => {
    expect(liveCheck([trade(1)], null).status).toBe("tanpa pembanding");
  });

  it("kurang dari 10 trade belum dinilai", () => {
    const c = liveCheck(normal(6), exp);
    expect(c.status).toBe("terlalu sedikit");
    expect(liveReportText(c)).toContain("butuh minimal 10");
  });

  it("hasil yang sejalan dengan backtest: wajar", () => {
    const c = liveCheck(normal(30), exp);
    expect(c.n).toBe(30);
    expect(c.status).toBe("wajar");
    expect(c.liveWin).toBeCloseTo(10 / 30, 5);
  });

  it("rugi terus jauh di bawah backtest: jauh di bawah", () => {
    const c = liveCheck(Array.from({ length: 30 }, () => trade(-1)), exp);
    expect(c.z).toBeLessThan(-2);
    expect(c.status).toBe("jauh di bawah");
    expect(liveReportText(c)).toContain("JAUH di bawah");
  });

  it("kalah beruntun dihitung dari trade terakhir dengan peluang menurut win rate backtest", () => {
    const c = liveCheck([...normal(10), ...Array.from({ length: 12 }, () => trade(-1))], exp);
    expect(c.streak).toBe(12);
    expect(c.streakP).toBeCloseTo(0.66 ** 12, 8);
    expect(c.streakP).toBeLessThan(0.01);
  });

  it("trade dari strategi tanpa pembanding tidak ikut dinilai", () => {
    const c = liveCheck([...normal(10), trade(-1, "DOGEUSDT")], exp);
    expect(c.n).toBe(10);
    expect(c.unmatched).toBe(1);
  });

  it("dry run tidak dihitung sebagai trade live", () => {
    const c = liveCheck([{ ...trade(-1), mode: "dry_run" }].filter(t => t.mode === "live"), exp);
    expect(c.n).toBe(0);
  });
});
