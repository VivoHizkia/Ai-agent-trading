import { describe, expect, it } from "vitest";
import { syntheticCandles } from "../src/data/synthetic.js";
import { STRATEGIES } from "../src/strategies/index.js";

// Sinyal di bar i hanya boleh bergantung pada data sampai i. Kalau memotong data setelah i mengubah sinyalnya,
// strategi itu "mengintip masa depan" dan hasil backtest-nya palsu.
const candles = syntheticCandles({ bars: 900, tf: "4h", seed: 7, start: Date.UTC(2024, 0, 1), price: 100 });

describe("strategi tanpa look-ahead", () => {
  for (const def of STRATEGIES) {
    it(`${def.id}: sinyal sama dengan data terpotong maupun lengkap`, () => {
      const full = def.create({ ...def.defaults });
      full.prepare(candles);
      let compared = 0, signals = 0;
      for (let i = full.warmup; i < candles.length; i += 7) {
        const cut = def.create({ ...def.defaults });
        cut.prepare(candles.slice(0, i + 1));
        const a = full.signal(i), b = cut.signal(i);
        expect(b).toEqual(a);
        compared++;
        if (a) signals++;
      }
      expect(compared).toBeGreaterThan(50);
      expect(signals).toBeGreaterThanOrEqual(0);
    });
  }
});
