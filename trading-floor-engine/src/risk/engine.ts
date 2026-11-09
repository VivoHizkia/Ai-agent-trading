// Risk Engine deterministik. Dipakai SAMA PERSIS oleh backtest dan (nanti) live/paper.
// Tidak ada LLM atau agent yang bisa menimpa keputusan ini. Aturan hanya diubah oleh Bos lewat RiskRules.
import type { Intent, MarketSpec } from "../types.js";

export interface RiskRules {
  riskPct: number; // % equity yang dipertaruhkan per trade
  maxLeverage: number;
  minRR: number; // hanya berlaku untuk setup dengan target tetap
  dailyLossPct: number; // batas rugi harian dari equity awal hari
  maxOpenPositions: number;
  /** Jumlah posisi yang berbagi margin akun di SEMUA timeframe (bot: 2 per timeframe x 4h & 1h = 4).
   * Jatah margin satu posisi = 90% equity / marginSlots. Kosong = sama dengan maxOpenPositions. */
  marginSlots?: number;
  /** Stop harus kena sebelum likuidasi: jarak entry→stop maksimal fraksi ini dari jarak entry→likuidasi. */
  maxStopToLiqFraction: number;
}

export const DEFAULT_RULES: RiskRules = {
  riskPct: 10,
  maxLeverage: 25,
  minRR: 2,
  dailyLossPct: 3,
  maxOpenPositions: 2,
  marginSlots: 4,
  maxStopToLiqFraction: 0.5,
};

export interface RiskInput {
  intent: Intent;
  refPrice: number; // harga acuan sizing (close bar sinyal)
  equity: number;
  dayStartEquity: number;
  dayPnl: number; // realized + unrealized hari ini
  openPositions: number;
  spec: MarketSpec;
  trailingExit: boolean; // strategi tanpa target tetap
  rules?: RiskRules;
}

export interface RiskDecision {
  ok: boolean;
  rejections: string[]; // kode alasan, stabil untuk statistik
  notes: string[];
  qty: number;
  notional: number;
  leverage: number;
  margin: number;
  liq: number;
  riskUsd: number;
  rr: number | null;
}

/** Perkiraan harga likuidasi isolated margin, kontrak linear USDT-M. */
export function liquidationPrice(side: "long" | "short", entry: number, leverage: number, mmr: number): number {
  return side === "long" ? entry * (1 - 1 / leverage + mmr) : entry * (1 + 1 / leverage - mmr);
}

export function evaluateRisk(input: RiskInput): RiskDecision {
  const rules = input.rules ?? DEFAULT_RULES;
  const { intent, refPrice: ref, equity, spec } = input;
  const rejections: string[] = [];
  const notes: string[] = [];
  const empty: RiskDecision = { ok: false, rejections, notes, qty: 0, notional: 0, leverage: 0, margin: 0, liq: 0, riskUsd: 0, rr: null };

  if (!(equity > 0)) { rejections.push("equity_habis"); return empty; }
  if (!Number.isFinite(intent.stop) || intent.stop <= 0) { rejections.push("tanpa_stop"); return empty; }
  const stopOk = intent.side === "long" ? intent.stop < ref : intent.stop > ref;
  if (!stopOk) { rejections.push("stop_salah_sisi"); return empty; }
  if (input.openPositions >= rules.maxOpenPositions) rejections.push("maks_posisi");
  if (input.dayPnl <= -(rules.dailyLossPct / 100) * input.dayStartEquity) rejections.push("batas_rugi_harian");

  let rr: number | null = null;
  if (intent.target !== undefined) {
    const tgtOk = intent.side === "long" ? intent.target > ref : intent.target < ref;
    if (!tgtOk) rejections.push("target_salah_sisi");
    rr = Math.abs(intent.target - ref) / Math.abs(ref - intent.stop);
    if (rr < rules.minRR - 1e-9) rejections.push("rr_kurang");
  } else if (input.trailingExit) {
    notes.push("exit trailing, R:R tidak tetap");
  } else {
    rejections.push("tanpa_target");
  }

  const stopDist = Math.abs(ref - intent.stop);
  let riskUsd = equity * (rules.riskPct / 100);
  let qty = riskUsd / stopDist;
  let notional = qty * ref;

  // Leverage serendah mungkin dengan syarat margin satu posisi muat di "jatahnya": 90% equity dibagi jumlah
  // posisi yang bisa terbuka bersamaan di semua timeframe (marginSlots). Tanpa ini, posisi awal bisa memakan
  // seluruh margin dan posisi berikutnya ditolak exchange ("Margin is insufficient").
  // Jatah kecil itu butuh leverage tinggi; kalau leverage itu membuat stop terlalu dekat likuidasi, pakai margin
  // lebih besar (paling banyak jatah maxOpenPositions, aturan lama) dengan leverage tertinggi yang masih aman.
  // Akibatnya posisi ke-3/ke-4 bisa ditolak exchange karena margin, dan itu aman: tidak ada posisi yang terbuka.
  const slotFor = (n: number) => (equity * 0.9) / n;
  const levFor = (slot: number) => Math.max(1, Math.ceil(notional / slot));
  const liqSafe = (lev: number) => stopDist <= rules.maxStopToLiqFraction * Math.abs(ref - liquidationPrice(intent.side, ref, lev, spec.maintenanceMarginRate));
  let marginSlot = slotFor(rules.marginSlots ?? rules.maxOpenPositions);
  let leverage = levFor(marginSlot);
  const wideSlot = slotFor(rules.maxOpenPositions);
  if (marginSlot < wideSlot && !liqSafe(Math.min(leverage, rules.maxLeverage))) {
    const minLev = levFor(wideSlot);
    while (leverage > minLev && !liqSafe(leverage)) leverage--;
    marginSlot = wideSlot;
    notes.push("margin di atas jatah semua timeframe supaya stop tetap jauh dari likuidasi");
  }
  if (leverage > rules.maxLeverage) {
    leverage = rules.maxLeverage;
    notional = marginSlot * rules.maxLeverage;
    qty = notional / ref;
    riskUsd = qty * stopDist;
    notes.push(`size dikurangi oleh batas leverage ${rules.maxLeverage}x`);
  }
  const margin = notional / leverage;
  const liq = liquidationPrice(intent.side, ref, leverage, spec.maintenanceMarginRate);
  const liqDist = Math.abs(ref - liq);
  if (stopDist > rules.maxStopToLiqFraction * liqDist) rejections.push("stop_terlalu_dekat_likuidasi");
  if (notional < spec.minNotional) rejections.push("di_bawah_min_notional");

  return { ok: rejections.length === 0, rejections, notes, qty, notional, leverage, margin, liq, riskUsd, rr };
}

export const REJECTION_LABEL: Record<string, string> = {
  equity_habis: "Equity habis",
  tanpa_stop: "Tidak ada stop loss",
  stop_salah_sisi: "Stop di sisi yang salah",
  maks_posisi: "Sudah maksimal posisi terbuka",
  batas_rugi_harian: "Batas rugi harian tercapai",
  target_salah_sisi: "Target di sisi yang salah",
  rr_kurang: "R:R di bawah minimum",
  tanpa_target: "Tidak ada target dan bukan strategi trailing",
  stop_terlalu_dekat_likuidasi: "Stop terlalu dekat harga likuidasi",
  di_bawah_min_notional: "Notional di bawah minimum order exchange",
};
