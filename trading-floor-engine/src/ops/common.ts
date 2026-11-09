// Utilitas bersama untuk layanan kantor (notifier, kalender, regime, lab, review).
import fs from "node:fs";
import path from "node:path";
import { OFFICE_DIR } from "../report/office.js";

export const EXEC_DIR = path.join(OFFICE_DIR, "execution");
export const MARKET_DIR = path.join(OFFICE_DIR, "market");

export const WIB_MS = 7 * 3_600_000;
export const wibDay = (t: number | string) => new Date((typeof t === "string" ? Date.parse(t) : t) + WIB_MS).toISOString().slice(0, 10);
export const wibTime = (t: number | string) => new Date((typeof t === "string" ? Date.parse(t) : t) + WIB_MS).toISOString().slice(11, 16);

/** Tulis atomik (tmp lalu rename) supaya dashboard tidak pernah membaca file setengah jadi. */
export function writeJsonAtomic(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, typeof data === "string" ? data : JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function readJsonl<T>(file: string, maxBytes = 2 * 1024 * 1024): T[] {
  let text = "";
  try {
    const st = fs.statSync(file);
    const n = Math.min(st.size, maxBytes);
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, st.size - n);
    fs.closeSync(fd);
    text = buf.toString("utf8");
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const l of text.split("\n")) {
    try { out.push(JSON.parse(l) as T); } catch { /* baris terpotong/rusak */ }
  }
  return out;
}

export interface EquityPoint { t: string; equity: number; mode?: string }
export interface TradeRecord {
  t: string; mode: string; symbol: string; tf: string; strategyId: string; side: "long" | "short";
  entry: number; exit: number; pnl: number; r: number; fees?: number; funding?: number; reason: string;
  openedAt?: number; closedAt?: number; crowd?: string | null;
}

/** Deposit/penarikan ke wallet futures (dicatat bot dari riwayat income Binance). amount + = masuk, − = keluar. */
export interface TransferRecord { t: string; amount: number; type: string; asset?: string }
export const transferRecords = () => readJsonl<TransferRecord>(path.join(EXEC_DIR, "transfers.jsonl")).filter(x => typeof x.t === "string" && Number.isFinite(x.amount));

/** Equity yang "dinormalisasi": tiap titik ditambah semua transfer SESUDAH titik itu. Kurva jadi mulus (deposit tidak
 * terlihat sebagai lonjakan untung, penarikan tidak terlihat sebagai rugi) dan titik terakhir tetap = saldo asli.
 * Selisih dua titik = untung/rugi trading saja. */
export function normalizeEquity<T extends { t: string; equity: number }>(pts: T[], transfers = transferRecords()): T[] {
  if (!transfers.length) return pts;
  const tr = transfers.map(x => ({ ms: Date.parse(x.t), a: x.amount })).filter(x => Number.isFinite(x.ms));
  return pts.map(p => {
    const ms = Date.parse(p.t);
    const later = tr.reduce((s, x) => (x.ms > ms ? s + x.a : s), 0);
    return later ? { ...p, equity: p.equity + later } : p;
  });
}

export const equityPoints = () => normalizeEquity(readJsonl<EquityPoint>(path.join(EXEC_DIR, "equity.jsonl")).filter(p => typeof p.t === "string" && Number.isFinite(p.equity)));
export const tradeRecords = () => readJsonl<TradeRecord>(path.join(EXEC_DIR, "trades.jsonl"), 4 * 1024 * 1024).filter(t => typeof t.t === "string" && Number.isFinite(t.pnl));

export function logLinesBetween(from: number, to: number): { t: string; msg: string }[] {
  let files: string[] = [];
  try { files = fs.readdirSync(EXEC_DIR).filter(f => /^log-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)); } catch { return []; }
  const out: { t: string; msg: string }[] = [];
  for (const f of files) {
    const day = Date.parse(f.slice(4, 14) + "T00:00:00Z");
    if (day + 86_400_000 < from || day > to) continue;
    for (const l of readJsonl<{ t: string; msg: string }>(path.join(EXEC_DIR, f))) {
      const t = Date.parse(l.t);
      if (t >= from && t < to) out.push(l);
    }
  }
  return out;
}

export function latestEquity(): number | null {
  const pts = equityPoints();
  return pts.length ? pts.at(-1)!.equity : null;
}
