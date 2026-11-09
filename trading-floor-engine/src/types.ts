// Tipe inti engine. Semua harga dalam USDT, semua waktu dalam epoch ms (UTC).

export type Side = "long" | "short";
export type Timeframe = "5m" | "15m" | "1h" | "4h" | "1d";

export const TF_MS: Record<Timeframe, number> = {
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

export interface Candle {
  t: number; // open time
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface FundingRate {
  t: number; // waktu settlement
  rate: number; // mis. 0.0001 = 0.01% per 8 jam
}

/** Niat entry dari strategi, dihitung di close bar i dan dieksekusi di open bar i+1. */
export interface Intent {
  side: Side;
  stop: number; // harga absolut, wajib
  target?: number; // harga absolut; kosong = exit pakai trailing/aturan strategi
  reason: string;
}

/** Instruksi manajemen posisi dari strategi di close bar. */
export interface Manage {
  newStop?: number; // hanya boleh mengetatkan stop
  exit?: boolean; // tutup di open bar berikutnya
  reason?: string;
}

export interface Position {
  side: Side;
  entry: number;
  qty: number;
  stop: number;
  initialStop: number;
  target?: number;
  leverage: number;
  margin: number;
  liq: number;
  entryIndex: number;
  entryTime: number;
  riskUsd: number;
  fees: number;
  funding: number; // negatif = dibayar
  reason: string;
}

export type ExitReason = "stop" | "target" | "trailing" | "signal" | "liquidation" | "end" | "daily_limit";

export interface Trade {
  side: Side;
  entryTime: number;
  exitTime: number;
  entry: number;
  exit: number;
  qty: number;
  leverage: number;
  pnl: number; // bersih setelah fee + funding
  fees: number;
  funding: number;
  r: number; // pnl / risk awal
  bars: number;
  exitReason: ExitReason;
  entryReason: string;
}

export interface MarketSpec {
  symbol: string;
  minNotional: number; // USDT
  maintenanceMarginRate: number; // tier pertama, mis. 0.004 untuk BTCUSDT
  takerFee: number; // mis. 0.0005
  makerFee: number; // mis. 0.0002
}

export const MARKET_SPECS: Record<string, MarketSpec> = {
  // Nilai default mendekati Binance USDT-M (tier pertama). Cek ulang di exchange sebelum live.
  BTCUSDT: { symbol: "BTCUSDT", minNotional: 100, maintenanceMarginRate: 0.004, takerFee: 0.0005, makerFee: 0.0002 },
  ETHUSDT: { symbol: "ETHUSDT", minNotional: 20, maintenanceMarginRate: 0.004, takerFee: 0.0005, makerFee: 0.0002 },
  XRPUSDT: { symbol: "XRPUSDT", minNotional: 5, maintenanceMarginRate: 0.005, takerFee: 0.0005, makerFee: 0.0002 },
};

export function marketSpec(symbol: string): MarketSpec {
  return MARKET_SPECS[symbol] ?? { symbol, minNotional: 5, maintenanceMarginRate: 0.01, takerFee: 0.0005, makerFee: 0.0002 };
}
