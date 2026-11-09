import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { syntheticCandles } from "../src/data/synthetic.js";
import { getStrategy } from "../src/strategies/index.js";
import { DEFAULT_RULES } from "../src/risk/engine.js";
import { selectParams, walkForward } from "../src/backtest/walkforward.js";

// OFFICE_DIR ke folder sementara SEBELUM modul diimpor: tes tidak boleh menyentuh params.json bot live.
let dir: string;
let tuning: typeof import("../src/ops/tuning.js");
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-tune-"));
  process.env.OFFICE_DIR = dir;
  vi.resetModules();
  tuning = await import("../src/ops/tuning.js");
  fs.mkdirSync(path.join(dir, "execution"), { recursive: true });
  fs.writeFileSync(path.join(dir, "execution", "watchlist.json"), JSON.stringify([{ symbol: "ZECUSDT", tf: "4h", strategyId: "ema_trend" }]));
});
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); delete process.env.OFFICE_DIR; });

const writeTuned = (tunedAt: string) => fs.writeFileSync(path.join(dir, "execution", "params.json"), JSON.stringify({
  updatedAt: tunedAt,
  rows: { "ZECUSDT 4h ema_trend": { params: { stopPct: 2, targetPct: 12 }, score: 1, trainFrom: "", trainTo: "", tunedAt } },
}));

describe("penyetelan 90 harian", () => {
  it("belum pernah disetel: jatuh tempo, setelan kosong (bot pakai default)", () => {
    expect(tuning.tuningDue()).toBe(true);
    expect(tuning.tunedParams({ symbol: "ZECUSDT", tf: "4h", strategyId: "ema_trend" })).toEqual({});
  });

  it("baru disetel: tidak jatuh tempo, setelan terbaca", () => {
    writeTuned(new Date().toISOString());
    expect(tuning.tuningDue()).toBe(false);
    expect(tuning.tunedParams({ symbol: "ZECUSDT", tf: "4h", strategyId: "ema_trend" })).toEqual({ stopPct: 2, targetPct: 12 });
  });

  it("lebih dari 90 hari: jatuh tempo lagi", () => {
    writeTuned(new Date(Date.now() - 91 * 86_400_000).toISOString());
    expect(tuning.tuningDue()).toBe(true);
  });

  it("selectParams memilih setelan yang sama dengan jendela terakhir walk-forward", () => {
    const candles = syntheticCandles({ bars: 4000, tf: "4h", seed: 3, start: Date.UTC(2023, 0, 1), price: 100 });
    const def = getStrategy("ema_trend");
    const cfg = { symbol: "TEST", tf: "4h" as const, initialEquity: 10_000, rules: { ...DEFAULT_RULES, riskPct: 1 } };
    const wf = walkForward(candles, def, cfg, [], { trainBars: 2190, testBars: 540 });
    const last = wf.windows.at(-1)!;
    const trS = candles.findIndex(c => c.t === last.trainFrom), trE = candles.findIndex(c => c.t === last.trainTo);
    expect(selectParams(candles, def, cfg, [], trS, trE).params).toEqual(last.params);
  });
});
