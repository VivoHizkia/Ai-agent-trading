// State posisi bot live, dipersist ke disk supaya restart tidak kehilangan jejak posisi terbuka.
import fs from "node:fs";
import path from "node:path";
import { OFFICE_DIR } from "../report/office.js";
import type { Side } from "../types.js";
import type { Params } from "../strategies/index.js";

export interface BotPosition {
  side: Side;
  entry: number;
  qty: number;
  stop: number;
  initialStop: number;
  target?: number;
  leverage: number;
  entryTime: number;
  riskUsd: number;
  reason: string;
  /** Waktu order entry dikirim (ms). Dipakai jurnal trade untuk mengambil fill & PnL dari Binance. */
  openedAt?: number;
  /** Ringkasan data crowd (funding/OI/L-S/F&G) saat entry, untuk jurnal. */
  crowd?: string;
  stopOrderId?: number;
  targetOrderId?: number;
  /** Setelan strategi saat entry: exit posisi ini tetap memakainya walau setelan disetel ulang di tengah jalan. */
  params?: Params;
}

export interface PendingApproval {
  id: string;
  side: Side;
  stop: number;
  target?: number;
  reason: string;
  qty: number;
  leverage: number;
  riskUsd: number;
  barTime: number;
  refPrice: number;
}

export interface WatchState {
  position: BotPosition | null;
  lastBarTime: number;
  dayKey: number;
  dayStartEquity: number;
  pendingApproval?: PendingApproval;
}

export type BotState = Record<string, WatchState>;

const STATE_FILE = path.join(OFFICE_DIR, "execution", "state.json");

export function loadState(): BotState {
  if (!fs.existsSync(STATE_FILE)) return {};
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as BotState;
}

export function saveState(state: BotState): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  // Tulis ke file sementara lalu rename: crash di tengah penulisan tidak boleh meninggalkan state.json setengah jadi
  // (bot tidak bisa start lagi dan jejak posisi terbuka hilang). Rename bisa ditolak Windows kalau file sedang
  // dibaca proses lain (UI/notifier); saat itu tulis langsung saja.
  const tmp = `${STATE_FILE}.tmp`;
  const data = JSON.stringify(state, null, 2);
  fs.writeFileSync(tmp, data);
  try { fs.renameSync(tmp, STATE_FILE); } catch { fs.writeFileSync(STATE_FILE, data); }
}

export function watchKey(symbol: string, tf: string, strategyId: string): string {
  return `${symbol}_${tf}_${strategyId}`;
}
