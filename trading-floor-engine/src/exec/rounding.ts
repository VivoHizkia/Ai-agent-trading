// Pembulatan ke aturan ASLI exchange (filter PRICE_FILTER.tickSize & LOT_SIZE.stepSize), bukan pricePrecision:
// pricePrecision Binance sering lebih banyak desimal daripada tickSize (mis. FETUSDT 7 desimal, tick 0.0001),
// dan harga yang bukan kelipatan tick ditolak exchange.

/** Jumlah desimal efektif dari string step Binance, mis. "0.0001000" → 4, "1" → 0. */
export function stepDecimals(step: string): number {
  const frac = step.includes(".") ? step.split(".")[1]!.replace(/0+$/, "") : "";
  return frac.length;
}

/** Harga ke kelipatan tick terdekat. */
export function roundToTick(price: number, tickSize: string): number {
  const t = Number(tickSize);
  return Number((Math.round(price / t) * t).toFixed(stepDecimals(tickSize)));
}

/** Quantity DIBULATKAN KE BAWAH ke kelipatan step, supaya risiko tidak pernah lebih besar dari hitungan Risk Engine. */
export function floorToStep(qty: number, stepSize: string): number {
  const s = Number(stepSize);
  return Number((Math.floor(qty / s + 1e-9) * s).toFixed(stepDecimals(stepSize)));
}
