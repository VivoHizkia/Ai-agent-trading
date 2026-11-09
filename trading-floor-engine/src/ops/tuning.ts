// Penyetelan berkala: tiap 90 hari, setelan tiap strategi watchlist dipilih ulang dari 365 hari data terakhir,
// dengan cara yang SAMA PERSIS seperti walk-forward (selectParams, risk evaluasi 1%). Itu yang diuji out-of-sample;
// parameter default tetap hanya pembanding. Hasil di execution/params.json, dibaca bot tiap tick.
import fs from "node:fs";
import path from "node:path";
import { selectParams } from "../backtest/walkforward.js";
import { loadWatchlist } from "../exec/watchlist.js";
import { DEFAULT_RULES } from "../risk/engine.js";
import { EVAL_RISK_PCT } from "../scan.js";
import { getStrategy, type Params } from "../strategies/index.js";
import { TF_MS, type Timeframe } from "../types.js";
import { refreshData } from "./discover.js";
import { EXEC_DIR, writeJsonAtomic } from "./common.js";

export const TUNED_FILE = path.join(EXEC_DIR, "params.json");
export const RETUNE_MS = 90 * 86_400_000; // sama dengan panjang jendela test walk-forward
const TRAIN_DAYS = 365;

export interface TunedRow { params: Params; score: number; trainFrom: string; trainTo: string; tunedAt: string }
export interface Tuned { updatedAt: string; rows: Record<string, TunedRow> }

export const tuneKey = (x: { symbol: string; tf: string; strategyId: string }) => `${x.symbol} ${x.tf} ${x.strategyId}`;

export function readTuned(): Tuned | null {
  try { return JSON.parse(fs.readFileSync(TUNED_FILE, "utf8")) as Tuned; } catch { return null; }
}

/** Setelan hasil penyetelan untuk satu baris watchlist (hanya kunci grid), atau {} kalau belum ada. */
export function tunedParams(x: { symbol: string; tf: string; strategyId: string }): Params {
  return readTuned()?.rows[tuneKey(x)]?.params ?? {};
}

/** Perlu disetel ulang: belum pernah, sudah 90 hari, atau ada baris watchlist yang belum punya setelan. */
export function tuningDue(now = Date.now()): boolean {
  const t = readTuned();
  if (!t) return true;
  return loadWatchlist().some(w => {
    const r = t.rows[tuneKey(w)];
    return !r || now - Date.parse(r.tunedAt) > RETUNE_MS;
  });
}

export interface TuneChange { key: string; before: Params | null; after: Params; score: number }

/** Setel ulang baris yang jatuh tempo (atau semua kalau force). Mengembalikan perubahan untuk dilaporkan. */
export async function tuneWatchlist(opts: { force?: boolean; onProgress?: (m: string) => void } = {}): Promise<TuneChange[]> {
  const log = opts.onProgress ?? (() => {});
  const prev = readTuned();
  const rows: Record<string, TunedRow> = { ...(prev?.rows ?? {}) };
  const changes: TuneChange[] = [];
  const now = Date.now();
  for (const w of loadWatchlist()) {
    const key = tuneKey(w);
    const old = rows[key];
    if (!opts.force && old && now - Date.parse(old.tunedAt) <= RETUNE_MS) continue;
    const tf = w.tf as Timeframe;
    try {
      const def = getStrategy(w.strategyId);
      const { candles, funding } = await refreshData(w.symbol, tf);
      const trainBars = Math.round((TRAIN_DAYS * 86_400_000) / TF_MS[tf]);
      const trE = candles.length - 1, trS = trE - trainBars + 1;
      const warmup = def.create({ ...def.defaults }).warmup;
      if (trS < warmup) { log(`${key}: data kurang dari ${TRAIN_DAYS} hari, tetap pakai default`); continue; }
      const cfg = { symbol: w.symbol, tf, initialEquity: 10_000, rules: { ...DEFAULT_RULES, riskPct: EVAL_RISK_PCT } };
      const { params, score } = selectParams(candles, def, cfg, funding, trS, trE);
      const gridOnly = Object.fromEntries(Object.keys(def.grid).map(k => [k, params[k]!]));
      rows[key] = { params: gridOnly, score, trainFrom: new Date(candles[trS]!.t).toISOString(), trainTo: new Date(candles[trE]!.t).toISOString(), tunedAt: new Date(now).toISOString() };
      changes.push({ key, before: old?.params ?? null, after: gridOnly, score });
      log(`${key}: ${fmt(gridOnly)}${Number.isFinite(score) ? "" : " (tidak ada setelan layak di 365 hari terakhir, pakai default)"}`);
    } catch (e) { log(`${key}: gagal disetel (${(e as Error).message}), setelan lama/default tetap dipakai`); }
  }
  writeJsonAtomic(TUNED_FILE, { updatedAt: new Date(now).toISOString(), rows });
  return changes;
}

const fmt = (p: Params) => Object.entries(p).map(([k, v]) => `${k}=${v}`).join(" ");

export function tuningTelegram(changes: TuneChange[]): string {
  const changed = changes.filter(c => !c.before || fmt(c.before) !== fmt(c.after));
  return [
    "🎛️ <b>Setelan strategi diperbarui</b> (tiap 90 hari, dari data 365 hari terakhir)",
    ...(changed.length
      ? changed.map(c => `• ${c.key}: ${c.before ? `${fmt(c.before)} → ` : ""}<b>${fmt(c.after)}</b>`)
      : ["Tidak ada yang berubah."]),
    `<i>${changes.length - changed.length} strategi tetap sama. Posisi yang sedang terbuka tetap memakai setelan saat entry.</i>`,
  ].join("\n");
}
