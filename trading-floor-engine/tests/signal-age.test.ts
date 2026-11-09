import { describe, expect, it } from "vitest";
import { isStaleSignal, MAX_SIGNAL_AGE_MS, signalAgeMs } from "../src/exec/signal-age.js";

const H = 3_600_000;
// Candle 4h 03:00–07:00 WIB 30 Okt (open 20:00 UTC 29 Okt), kasus nyata: diproses 10:00 WIB.
const barT = Date.UTC(2026, 9, 29, 20);

describe("umur sinyal", () => {
  it("diproses normal 30-90 detik setelah candle selesai: segar", () => {
    expect(isStaleSignal(barT, "4h", barT + 4 * H + 30_000)).toBe(false);
    expect(isStaleSignal(barT, "4h", barT + 4 * H + 90_000)).toBe(false);
  });

  it("diproses 3 jam setelah candle selesai (30 Okt 10:00): basi, entry dilewati", () => {
    expect(isStaleSignal(barT, "4h", barT + 7 * H)).toBe(true);
    expect(signalAgeMs(barT, "4h", barT + 7 * H)).toBe(3 * H);
  });

  it("batasnya 15 menit, juga untuk 1h", () => {
    expect(MAX_SIGNAL_AGE_MS).toBe(15 * 60_000);
    expect(isStaleSignal(barT, "1h", barT + H + 14 * 60_000)).toBe(false);
    expect(isStaleSignal(barT, "1h", barT + H + 16 * 60_000)).toBe(true);
  });
});
