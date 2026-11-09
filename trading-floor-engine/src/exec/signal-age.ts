// Umur sinyal: backtest selalu entry tepat setelah candle sinyal selesai. Setelah bot lama mati, candle terakhir yang
// belum diproses bisa sudah selesai berjam-jam lalu (30 Okt: candle 07:00 baru diproses 10:00); entry dari candle
// itu memakai harga dan jarak SL yang sudah basi, jadi dilewati.
import { TF_MS, type Timeframe } from "../types.js";

/** Batas umur candle sinyal untuk entry baru. Bot normal memproses ±30-90 detik setelah candle selesai. */
export const MAX_SIGNAL_AGE_MS = 15 * 60_000;

/** Milidetik sejak candle (open time barT) selesai. */
export function signalAgeMs(barT: number, tf: Timeframe, now = Date.now()): number {
  return now - (barT + TF_MS[tf]);
}

export const isStaleSignal = (barT: number, tf: Timeframe, now = Date.now()) => signalAgeMs(barT, tf, now) > MAX_SIGNAL_AGE_MS;
