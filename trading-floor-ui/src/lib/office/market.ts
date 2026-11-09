import "server-only";
import fs from "node:fs";
import path from "node:path";
import type { PriceView } from "../types";
import { ENGINE_DATA_DIR, statSafe } from "./fsx";
import { readExecution, readMarketSnapshot } from "./readers";

// Harga untuk ticker & papan Lobby. Hanya endpoint publik (tanpa API key), read-only.
// Urutan: Binance Futures 24hr → office/market/snapshot.json → close terakhir di data/<SYMBOL>_4h.json.

const CACHE_MS = 15_000;
let cache: { at: number; key: string; prices: PriceView[] } | null = null;

async function fetchBinance(symbol: string): Promise<{ last: number; chg: number } | null> {
  try {
    const res = await fetch(`https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${encodeURIComponent(symbol)}`, {
      signal: AbortSignal.timeout(4000),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { lastPrice?: string; priceChangePercent?: string };
    const last = Number(j.lastPrice);
    const chg = Number(j.priceChangePercent);
    return Number.isFinite(last) ? { last, chg: Number.isFinite(chg) ? chg : 0 } : null;
  } catch {
    return null;
  }
}

function lastCloseFromData(symbol: string): number | null {
  if (!/^[A-Z0-9]{2,20}$/.test(symbol)) return null;
  const file = path.join(ENGINE_DATA_DIR, `${symbol}_4h.json`);
  const st = statSafe(file);
  if (!st) return null;
  try {
    const fd = fs.openSync(file, "r");
    try {
      const n = Math.min(400, st.size);
      const buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, st.size - n);
      const matches = [...buf.toString("utf8").matchAll(/"c":\s*([\d.]+)/g)];
      const v = Number(matches.at(-1)?.[1]);
      return Number.isFinite(v) ? v : null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

export async function getPrices(): Promise<PriceView[]> {
  const exec = readExecution();
  const snap = readMarketSnapshot();
  const symbols = [...new Set(["BTCUSDT", ...exec.positions.map(p => p.symbol), ...exec.watchlist.map(w => w.symbol)])].slice(0, 8);
  const key = symbols.join(",");
  if (cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.prices;

  const prices: PriceView[] = [];
  const live = await Promise.all(symbols.map(fetchBinance));
  symbols.forEach((symbol, i) => {
    const s = snap.rows.find(r => r.symbol === symbol);
    const funding = s?.fundingRatePct ?? null;
    const l = live[i];
    if (l) {
      prices.push({ symbol, last: l.last, chgPct: l.chg, fundingPct: funding, source: "binance" });
    } else if (s?.markPrice != null) {
      prices.push({ symbol, last: s.markPrice, chgPct: null, fundingPct: funding, source: "snapshot" });
    } else {
      const c = lastCloseFromData(symbol);
      if (c != null) prices.push({ symbol, last: c, chgPct: null, fundingPct: funding, source: "data" });
    }
  });
  cache = { at: Date.now(), key, prices };
  return prices;
}
