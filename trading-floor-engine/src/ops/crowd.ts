// Data "keramaian pasar" gratis (tanpa API key): funding, open interest, rasio long/short top trader, taker buy/sell
// (semua dari endpoint publik Binance Futures) + Crypto Fear & Greed Index (alternative.me).
// Ditulis ke office/market/crowd.json. Dipakai: konteks di log entry & jurnal, Ruang Regime, dan filter opsional di bot.
// Catatan: data OI & long/short Binance hanya tersedia ~30 hari ke belakang, jadi belum bisa di-backtest bertahun-tahun.
import fs from "node:fs";
import path from "node:path";
import { fetchOpenInterestHist } from "../data/binance.js";
import { loadWatchlist } from "../exec/watchlist.js";
import { MARKET_DIR, writeJsonAtomic } from "./common.js";

export const CROWD_FILE = path.join(MARKET_DIR, "crowd.json");
const BASE = process.env.BINANCE_FAPI ?? "https://fapi.binance.com";
const FNG_URL = process.env.FNG_URL ?? "https://api.alternative.me/fng/?limit=2";

// Ambang "ramai" — bisa diubah lewat .env
const FUNDING_HOT = Number(process.env.CROWD_FUNDING_PCT ?? 0.03) / 100;   // 0.03% per 8 jam
const OI_JUMP = Number(process.env.CROWD_OI_JUMP_PCT ?? 5);               // OI naik >= 5% dalam 24 jam
const LS_LONG = Number(process.env.CROWD_LS_LONG ?? 1.8);                 // top trader long/short ratio
const LS_SHORT = Number(process.env.CROWD_LS_SHORT ?? 0.8);

export type CrowdFlag = "long ramai" | "short ramai" | "normal";

export interface CrowdRow {
  symbol: string;
  funding: number | null;        // desimal, mis. 0.0001 = 0.01%
  oiChg24h: number | null;       // persen
  lsRatio: number | null;        // top trader long/short (posisi)
  takerRatio: number | null;     // rata-rata buy/sell 6 jam terakhir
  flag: CrowdFlag;
  note: string;
}
export interface FearGreed { value: number; label: string; prev: number | null; at: string }
export interface CrowdFile { updatedAt: string; fearGreed: FearGreed | null; rows: CrowdRow[]; source: string }

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json() as Promise<T>;
}

export function classifyCrowd(r: Omit<CrowdRow, "flag" | "note">): { flag: CrowdFlag; note: string } {
  const f = r.funding, oi = r.oiChg24h, ls = r.lsRatio;
  if (f != null && oi != null && ls != null) {
    if (f >= FUNDING_HOT && oi >= OI_JUMP && ls >= LS_LONG) return { flag: "long ramai", note: "Funding tinggi, OI melonjak, top trader dominan long: rawan long squeeze." };
    if (f <= -FUNDING_HOT / 3 && oi >= OI_JUMP && ls <= LS_SHORT) return { flag: "short ramai", note: "Funding negatif, OI melonjak, top trader dominan short: rawan short squeeze." };
  }
  return { flag: "normal", note: "" };
}

export async function fetchFearGreed(): Promise<FearGreed | null> {
  try {
    const j = await getJson<{ data?: { value: string; value_classification: string; timestamp: string }[] }>(FNG_URL);
    const d = j.data ?? [];
    if (!d[0]) return null;
    return { value: Number(d[0].value), label: d[0].value_classification, prev: d[1] ? Number(d[1].value) : null, at: new Date(Number(d[0].timestamp) * 1000).toISOString() };
  } catch { return null; }
}

export async function crowdFor(symbol: string): Promise<CrowdRow> {
  const [pi, oi, ls, tk] = await Promise.all([
    getJson<{ lastFundingRate: string }>(`${BASE}/fapi/v1/premiumIndex?symbol=${symbol}`).catch(() => null),
    fetchOpenInterestHist(symbol, "1h", 25).catch(() => []),
    getJson<{ longShortRatio: string }[]>(`${BASE}/futures/data/topLongShortPositionRatio?symbol=${symbol}&period=1h&limit=1`).catch(() => []),
    getJson<{ buySellRatio: string }[]>(`${BASE}/futures/data/takerlongshortRatio?symbol=${symbol}&period=1h&limit=6`).catch(() => []),
  ]);
  const base = {
    symbol,
    funding: pi ? Number(pi.lastFundingRate) : null,
    oiChg24h: oi.length >= 2 ? ((oi.at(-1)!.oiValue / oi[0]!.oiValue) - 1) * 100 : null,
    lsRatio: ls[0] ? Number(ls[0].longShortRatio) : null,
    takerRatio: tk.length ? tk.reduce((s, x) => s + Number(x.buySellRatio), 0) / tk.length : null,
  };
  return { ...base, ...classifyCrowd(base) };
}

export async function refreshCrowd(): Promise<CrowdFile | null> {
  let watch: { symbol: string }[] = [];
  try { watch = loadWatchlist(); } catch { /* kosong */ }
  const symbols = [...new Set(["BTCUSDT", ...watch.map(w => w.symbol)])].slice(0, 20);
  const rows: CrowdRow[] = [];
  for (const s of symbols) rows.push(await crowdFor(s));
  const fearGreed = await fetchFearGreed();
  if (!rows.some(r => r.funding != null) && !fearGreed) return null;
  const file: CrowdFile = { updatedAt: new Date().toISOString(), fearGreed, rows, source: "Binance Futures (publik) · Fear & Greed: alternative.me" };
  writeJsonAtomic(CROWD_FILE, file);
  return file;
}

export function readCrowd(): CrowdFile | null {
  try { return JSON.parse(fs.readFileSync(CROWD_FILE, "utf8")) as CrowdFile; } catch { return null; }
}

/** Ringkasan satu baris untuk log entry & jurnal. Membaca file lokal saja (tanpa jaringan), jadi aman dipanggil dari bot. */
export function crowdContext(symbol: string, side: "long" | "short"): { text: string; againstCrowd: boolean; flag: CrowdFlag; fearGreed: number | null } | null {
  const c = readCrowd();
  if (!c) return null;
  const ageMin = (Date.now() - Date.parse(c.updatedAt)) / 60_000;
  const r = c.rows.find(x => x.symbol === symbol);
  const parts: string[] = [];
  if (r?.funding != null) parts.push(`funding ${(r.funding * 100).toFixed(4)}%`);
  if (r?.oiChg24h != null) parts.push(`OI 24j ${r.oiChg24h >= 0 ? "+" : ""}${r.oiChg24h.toFixed(1)}%`);
  if (r?.lsRatio != null) parts.push(`L/S ${r.lsRatio.toFixed(2)}`);
  if (r?.takerRatio != null) parts.push(`taker ${r.takerRatio.toFixed(2)}`);
  if (c.fearGreed) parts.push(`F&G ${c.fearGreed.value} (${c.fearGreed.label})`);
  if (ageMin > 90) parts.push(`data ${Math.round(ageMin)} menit lalu`);
  const flag = r?.flag ?? "normal";
  const againstCrowd = (flag === "long ramai" && side === "long") || (flag === "short ramai" && side === "short");
  if (againstCrowd) parts.push(`SEARAH CROWD (${flag})`);
  return parts.length ? { text: parts.join(", "), againstCrowd, flag, fearGreed: c.fearGreed?.value ?? null } : null;
}
