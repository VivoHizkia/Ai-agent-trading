// Daftar yang BOLEH ditradingkan bot — harus diisi manual oleh operator. Tidak otomatis dari scan/debate.
import fs from "node:fs";
import path from "node:path";
import { OFFICE_DIR } from "../report/office.js";
import type { Params } from "../strategies/index.js";
import type { Timeframe } from "../types.js";

export interface WatchlistEntry {
  symbol: string;
  tf: Timeframe;
  strategyId: string;
  params?: Params;
  /** Opsional: risk per trade khusus baris ini (% equity). Hanya boleh LEBIH KECIL dari aturan Risk Engine; nilai lebih besar diabaikan. */
  riskPct?: number;
}

const WATCHLIST_FILE = path.join(OFFICE_DIR, "execution", "watchlist.json");

export function loadWatchlist(): WatchlistEntry[] {
  if (!fs.existsSync(WATCHLIST_FILE)) return [];
  return JSON.parse(fs.readFileSync(WATCHLIST_FILE, "utf8")) as WatchlistEntry[];
}

export function watchlistPath(): string {
  return WATCHLIST_FILE;
}

export function writeWatchlistTemplate(): string {
  const example: WatchlistEntry[] = [{ symbol: "ADAUSDT", tf: "4h", strategyId: "ema_adx" }];
  fs.mkdirSync(path.dirname(WATCHLIST_FILE), { recursive: true });
  const file = path.join(OFFICE_DIR, "execution", "watchlist.example.json");
  fs.writeFileSync(file, JSON.stringify(example, null, 2));
  return file;
}
