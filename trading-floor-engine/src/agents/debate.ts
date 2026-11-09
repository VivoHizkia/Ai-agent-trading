// Debat bull/bear atas satu kandidat hasil scan, grounded hanya pada angka backtest — bukan opini pasar bebas.
import { z } from "zod";
import type { ScanRow } from "../scan.js";
import { llmJson } from "./llm.js";

const DebateSchema = z.object({
  bullCase: z.string().describe("2-4 kalimat argumen bull, berdasarkan angka yang diberikan saja"),
  bearCase: z.string().describe("2-4 kalimat argumen bear/skeptis, berdasarkan angka yang diberikan saja"),
  verdict: z.enum(["go_paper", "watch", "reject"]).describe("go_paper = layak paper trading, watch = pantau dulu, reject = tolak"),
  confidence: z.enum(["low", "medium", "high"]),
  suggestedRiskPct: z.number().min(0.1).max(1).describe("Risk per trade yang disarankan untuk paper trading, persen, 0.1-1"),
  reasoning: z.string().describe("1-2 kalimat kenapa vonis akhir ini diambil"),
});

export interface DebateResult {
  symbol: string;
  tf: string;
  strategyId: string;
  strategyName: string;
  bullCase: string;
  bearCase: string;
  verdict: "go_paper" | "watch" | "reject";
  confidence: "low" | "medium" | "high";
  suggestedRiskPct: number;
  reasoning: string;
  model: string;
  createdAt: string;
}

const n = (x: number, dp = 2) => (Number.isFinite(x) ? x.toFixed(dp) : x > 0 ? "inf" : "-");

function groundingFacts(row: ScanRow, realEquity: number): string {
  const m = row.wf.oos.metrics;
  const d = row.wf.defaultsOnSameSpan.metrics;
  return [
    `Aset: ${row.symbol} ${row.tf} · Strategi: ${row.strategyName} (${row.strategyId})`,
    `Walk-forward out-of-sample: ${row.wf.windows.length} jendela, ${row.wf.combosTried} kombinasi parameter dicoba per jendela`,
    `Trade OOS: ${m.trades} · Win rate ${n(m.winRatePct, 1)}% · Profit factor ${n(m.profitFactor)} · Expectancy ${n(m.avgR)}R`,
    `Return OOS ${n(m.returnPct, 1)}% · CAGR ${n(m.cagrPct, 1)}% · Sharpe ${n(m.sharpe)} · Max DD ${n(m.maxDrawdownPct, 1)}%`,
    `Avg win ${n(m.avgWinR)}R · avg loss ${n(m.avgLossR)}R · rugi beruntun terpanjang ${m.maxLosingStreak}`,
    `Buy & hold di rentang sama: ${n(row.wf.oos.buyHoldPct, 1)}%`,
    row.mc
      ? `Monte Carlo (resample trade): skenario 5% terburuk ${n(row.mc.p5ReturnPct, 1)}%, max DD 5% terburuk ${n(row.mc.p95MaxDDPct, 1)}%`
      : "Monte Carlo: tidak dihitung",
    `Parameter default tanpa optimasi di rentang sama: return ${n(d.returnPct, 1)}%, PF ${n(d.profitFactor)}, ${d.trades} trade`,
    `Vonis engine (deterministik): ${row.verdict.label} — ${row.verdict.reasons.join("; ")}`,
    `Kelayakan eksekusi di equity nyata $${realEquity}: ${row.feasibility.accepted} dari ${row.feasibility.signals} sinyal lolos Risk Engine` +
      (row.feasibility.topRejection ? ` (ditolak terbanyak: ${row.feasibility.topRejection})` : ""),
  ].join("\n");
}

const SYSTEM = `Kamu menjalankan simulasi dua periset meja trading futures crypto: Bull dan Bear.
Dasarnya HANYA angka hasil backtest walk-forward out-of-sample yang diberikan di pesan user — jangan mengarang berita, fundamental, atau data pasar lain yang tidak ada di sana.
Bull: cari alasan kuat KENAPA statistik ini layak dipercaya (edge independen dari arah pasar, sampel cukup, DD terkendali, Monte Carlo masih positif, dll).
Bear: cari alasan kuat untuk SKEPTIS (sampel kecil, risiko data-dredging karena strategi ini salah satu dari banyak kombinasi yang discan, overfitting parameter per jendela walk-forward, max DD, ketergantungan rejim pasar tertentu, kalah dari buy & hold, dll).
Setelah kedua sisi, beri vonis akhir yang HARUS lebih ketat daripada vonis deterministik engine, bukan sekadar mengulanginya — "go_paper" tidak pernah berarti siap pakai uang asli, itu tetap keputusan manusia.`;

export async function runDebate(row: ScanRow, opts: { realEquity: number; model?: string }): Promise<DebateResult> {
  const { data: parsed, model } = await llmJson(DebateSchema, {
    system: SYSTEM, user: groundingFacts(row, opts.realEquity), maxTokens: 2000,
    anthropicModel: opts.model ?? process.env.DEBATE_MODEL ?? "claude-opus-5",
  });
  return { symbol: row.symbol, tf: row.tf, strategyId: row.strategyId, strategyName: row.strategyName, ...parsed, model, createdAt: new Date().toISOString() };
}
