// Ringkasan harga + funding buat ticker dashboard. Data mentah saja, tidak ada analisa/LLM di sini.
import fs from "node:fs";
import path from "node:path";
import { fetchPremiumIndex } from "../data/binance.js";
import { OFFICE_DIR } from "../report/office.js";

const SYMBOLS = (process.env.MARKET_SNAPSHOT_SYMBOLS ?? "BTCUSDT,ETHUSDT").split(",").map(s => s.trim()).filter(Boolean);

export async function writeMarketSnapshot() {
  const rows = await Promise.all(SYMBOLS.map(async symbol => {
    try {
      const p = await fetchPremiumIndex(symbol);
      return { symbol: p.symbol, markPrice: p.markPrice, fundingRatePct: p.lastFundingRate * 100, nextFundingTime: p.nextFundingTime };
    } catch (e) {
      return { symbol, error: (e as Error).message };
    }
  }));
  const file = path.join(OFFICE_DIR, "market", "snapshot.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ updatedAt: new Date().toISOString(), rows }, null, 2));
  return rows;
}

writeMarketSnapshot().then(rows => {
  for (const r of rows) console.log("error" in r ? `${r.symbol}: ${r.error}` : `${r.symbol}: $${r.markPrice} · funding ${r.fundingRatePct.toFixed(4)}%`);
});
