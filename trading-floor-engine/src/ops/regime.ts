// Regime market per pair (4h): tren naik / tren turun / sideways / volatil / transisi, memakai indikator yang
// sama dengan strategi (src/indicators.ts). Ditulis ke office/market/regime.json untuk Ruang Regime.
import path from "node:path";
import { fetchKlines } from "../data/binance.js";
import { adx, atr, ema } from "../indicators.js";
import { loadWatchlist } from "../exec/watchlist.js";
import { TF_MS, type Candle } from "../types.js";
import { MARKET_DIR, writeJsonAtomic } from "./common.js";

export const REGIME_FILE = path.join(MARKET_DIR, "regime.json");

export type Regime = "tren_naik" | "tren_turun" | "sideways" | "volatil" | "transisi";
export const REGIME_LABEL: Record<Regime, string> = {
  tren_naik: "Tren naik", tren_turun: "Tren turun", sideways: "Sideways", volatil: "Volatil", transisi: "Transisi",
};

export interface RegimeRow { symbol: string; regime: Regime; label: string; close: number; adx: number; ema50: number; ema200: number; atrPct: number; atrPctile: number; chg24h: number }
export interface StrategyFit { symbol: string; tf: string; strategyId: string; regime: Regime; fit: "cocok" | "kurang cocok" | "netral"; note: string }

export function classify(c: Candle[]): Omit<RegimeRow, "symbol" | "label"> | null {
  if (c.length < 220 || c.some(x => !(x.c > 0))) return null;
  const close = c.map(x => x.c);
  const e50 = ema(close, 50), e200 = ema(close, 200);
  const a = adx(c, 14).adx, at = atr(c, 14);
  const i = c.length - 1;
  const atrPct = (at[i]! / close[i]!) * 100;
  const hist = at.slice(-200).map((v, k) => (v / close[close.length - 200 + k]!) * 100).filter(Number.isFinite);
  const atrPctile = (hist.filter(v => v <= atrPct).length / Math.max(1, hist.length)) * 100;
  const adxNow = a[i]!;
  let regime: Regime = "transisi";
  if (atrPctile >= 90) regime = "volatil";
  else if (adxNow >= 25 && e50[i]! > e200[i]! && close[i]! > e50[i]!) regime = "tren_naik";
  else if (adxNow >= 25 && e50[i]! < e200[i]! && close[i]! < e50[i]!) regime = "tren_turun";
  else if (adxNow < 20) regime = "sideways";
  const bars24 = Math.round(86_400_000 / TF_MS["4h"]);
  return { regime, close: close[i]!, adx: adxNow, ema50: e50[i]!, ema200: e200[i]!, atrPct, atrPctile, chg24h: ((close[i]! / close[i - bars24]!) - 1) * 100 };
}

/** Strategi tren suka regime tren; mean reversion suka sideways; trend_long hanya cocok di tren naik. */
export function fitFor(strategyId: string, r: Regime): { fit: StrategyFit["fit"]; note: string } {
  const trend = ["ema_trend", "donchian", "ema_adx"];
  if (trend.includes(strategyId)) {
    if (r === "tren_naik" || r === "tren_turun") return { fit: "cocok", note: "Strategi tren di pasar yang sedang tren." };
    if (r === "sideways") return { fit: "kurang cocok", note: "Strategi tren di pasar sideways: rawan whipsaw (sumber rugi terbesar di backtest)." };
    if (r === "volatil") return { fit: "kurang cocok", note: "Volatilitas sangat tinggi: stop lebih mudah tersapu." };
    return { fit: "netral", note: "Pasar sedang transisi, belum jelas arahnya." };
  }
  if (strategyId === "trend_long") {
    if (r === "tren_naik") return { fit: "cocok", note: "Long-only di tren naik." };
    if (r === "tren_turun") return { fit: "kurang cocok", note: "Long-only melawan tren turun." };
    return { fit: r === "sideways" ? "kurang cocok" : "netral", note: "Long-only butuh tren naik yang jelas." };
  }
  if (strategyId === "rsi_range") {
    if (r === "sideways") return { fit: "cocok", note: "Mean reversion di pasar sideways." };
    if (r === "tren_naik" || r === "tren_turun" || r === "volatil") return { fit: "kurang cocok", note: "Mean reversion melawan tren/volatilitas." };
  }
  return { fit: "netral", note: "" };
}

export async function refreshRegime(): Promise<{ rows: RegimeRow[]; fits: StrategyFit[] } | null> {
  let watch: { symbol: string; tf: string; strategyId: string }[] = [];
  try { watch = loadWatchlist(); } catch { /* watchlist kosong */ }
  const symbols = [...new Set(["BTCUSDT", ...watch.map(w => w.symbol)])].slice(0, 20);
  const rows: RegimeRow[] = [];
  for (const symbol of symbols) {
    try {
      const candles = await fetchKlines(symbol, "4h", Date.now() - 320 * TF_MS["4h"]);
      const r = classify(candles);
      if (r) rows.push({ symbol, label: REGIME_LABEL[r.regime], ...r });
    } catch { /* simbol ini dilewati */ }
  }
  if (!rows.length) return null;
  const fits: StrategyFit[] = watch.map(w => {
    const r = rows.find(x => x.symbol === w.symbol);
    const f = r ? fitFor(w.strategyId, r.regime) : { fit: "netral" as const, note: "Data regime tidak tersedia." };
    return { symbol: w.symbol, tf: w.tf, strategyId: w.strategyId, regime: r?.regime ?? "transisi", ...f };
  });
  writeJsonAtomic(REGIME_FILE, { updatedAt: new Date().toISOString(), tf: "4h", rows, fits });
  return { rows, fits };
}
