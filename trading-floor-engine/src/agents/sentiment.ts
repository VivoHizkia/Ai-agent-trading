// Analis Sentimen: funding rate + open interest (data asli Binance) + jadwal event opsional (CoinMarketCal).
// Narasi dari Claude, grounded hanya pada angka yang diberikan — sama pola dengan debate.ts.
import { z } from "zod";
import { llmJson } from "./llm.js";
import { fetchFunding, fetchOpenInterestHist } from "../data/binance.js";
import { fetchUpcomingEvents } from "../data/coinmarketcal.js";
import { writeAgentStatus } from "../report/office.js";

const SentimentSchema = z.object({
  narrative: z.string().describe("2-3 kalimat narasi funding + open interest, bahasa biasa"),
  flag: z.enum(["sehat", "netral", "waspada"]).describe("waspada = funding ekstrem + OI naik cepat (crowd satu arah), sehat = funding wajar, netral = data tidak cukup jelas"),
});

export interface SentimentResult {
  symbol: string;
  latestFundingRate: number | null;
  oiChangePct: number | null;
  upcomingEvents: { title: string; date: string }[];
  narrative: string;
  flag: "sehat" | "netral" | "waspada";
  model: string;
  createdAt: string;
}

export async function runSentiment(symbol: string, anthropicModel = process.env.SENTIMENT_MODEL ?? "claude-opus-5"): Promise<SentimentResult> {
  const now = Date.now();
  const [funding, oi, events] = await Promise.all([
    fetchFunding(symbol, now - 3 * 86_400_000, now).catch(() => []),
    fetchOpenInterestHist(symbol, "4h", 42).catch(() => []),
    fetchUpcomingEvents(symbol),
  ]);

  const latestFundingRate = funding.length ? funding[funding.length - 1]!.rate : null;
  const oiChangePct = oi.length >= 2 ? ((oi[oi.length - 1]!.oiValue / oi[0]!.oiValue) - 1) * 100 : null;

  const facts = [
    `Aset: ${symbol}`,
    latestFundingRate !== null ? `Funding rate terbaru: ${(latestFundingRate * 100).toFixed(4)}% per 8 jam (rata-rata ${funding.length} settlement terakhir: ${(funding.reduce((s, f) => s + f.rate, 0) / funding.length * 100).toFixed(4)}%)` : "Funding rate: data tidak tersedia",
    oiChangePct !== null ? `Open interest berubah ${oiChangePct > 0 ? "+" : ""}${oiChangePct.toFixed(1)}% selama ~${oi.length * 4} jam terakhir` : "Open interest: data tidak tersedia",
    events.length ? `Event mendatang: ${events.map(e => `${e.title} (${e.date})`).join("; ")}` : "Tidak ada data jadwal event (CoinMarketCal tidak di-set atau kosong)",
  ].join("\n");

  const { data: parsed, model } = await llmJson(SentimentSchema, {
    system: "Kamu Analis Sentimen di meja trading futures crypto. Dasarnya HANYA angka yang diberikan — jangan mengarang berita atau data pasar lain. Funding positif tinggi + OI naik cepat biasanya berarti crowd long berlebihan (rawan long squeeze); funding negatif tinggi + OI naik biasanya crowd short berlebihan.",
    user: facts, maxTokens: 1000, anthropicModel,
  });

  writeAgentStatus("sentiment_analyst", `${symbol}: ${parsed.flag} — ${parsed.narrative.slice(0, 80)}${parsed.narrative.length > 80 ? "..." : ""}`);

  return {
    symbol, latestFundingRate, oiChangePct,
    upcomingEvents: events.map(e => ({ title: e.title, date: e.date })),
    ...parsed, model, createdAt: new Date().toISOString(),
  };
}
