import { describe, expect, it } from "vitest";
import { floorToStep, roundToTick, stepDecimals } from "../src/exec/rounding.js";

// Nilai tickSize/stepSize diambil dari exchangeInfo Binance 25 Okt 2026 untuk koin watchlist.
describe("pembulatan ke aturan exchange", () => {
  it("desimal dari string step Binance", () => {
    expect(stepDecimals("0.0001000")).toBe(4);
    expect(stepDecimals("0.010")).toBe(2);
    expect(stepDecimals("1")).toBe(0);
  });

  it("FETUSDT: pricePrecision 7 tapi tick 0.0001 — harga harus 4 desimal", () => {
    expect(roundToTick(0.123456789, "0.0001000")).toBe(0.1235);
  });

  it("AAVEUSDT: tick 0.010", () => {
    expect(roundToTick(312.3456, "0.010")).toBe(312.35);
  });

  it("ARBUSDT: tick 0.000010", () => {
    expect(roundToTick(0.181234, "0.000010")).toBe(0.18123);
  });

  it("quantity selalu dibulatkan ke BAWAH (risiko tidak membesar)", () => {
    expect(floorToStep(189.68, "0.1")).toBe(189.6);
    expect(floorToStep(17.999, "1")).toBe(17);
    expect(floorToStep(0.0855, "0.001")).toBe(0.085);
  });

  it("tidak salah karena floating point (0.3 / 0.1 = 2.9999…)", () => {
    expect(floorToStep(0.3, "0.1")).toBe(0.3);
  });
});
