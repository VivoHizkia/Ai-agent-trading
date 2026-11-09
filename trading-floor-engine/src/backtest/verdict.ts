// Vonis dalam bahasa biasa. Sengaja ketat: lebih baik menolak strategi bagus daripada meloloskan yang kebetulan.
import type { Metrics } from "./metrics.js";
import type { MonteCarloResult } from "./montecarlo.js";

export type VerdictLevel = "kandidat_paper" | "edge_tipis" | "tanpa_edge" | "sampel_kecil";

export interface Verdict { level: VerdictLevel; label: string; reasons: string[] }

export function verdict(oos: Metrics, mc: MonteCarloResult | null, buyHoldPct: number): Verdict {
  const reasons: string[] = [];
  if (oos.trades < 30) {
    reasons.push(`Hanya ${oos.trades} trade out-of-sample; butuh minimal 30 untuk menilai`);
    if (oos.avgR <= 0) reasons.push("Expectancy sejauh ini negatif");
    return { level: "sampel_kecil", label: "Sampel terlalu kecil", reasons };
  }
  if (oos.avgR <= 0 || oos.profitFactor < 1) {
    reasons.push(`Expectancy ${oos.avgR.toFixed(2)}R, profit factor ${oos.profitFactor.toFixed(2)}`);
    return { level: "tanpa_edge", label: "Tidak ada edge", reasons };
  }
  const pass = oos.profitFactor >= 1.3 && oos.maxDrawdownPct > -25 && (mc?.p5ReturnPct ?? -1) > 0;
  reasons.push(`Profit factor ${oos.profitFactor.toFixed(2)}, expectancy ${oos.avgR.toFixed(2)}R, max DD ${oos.maxDrawdownPct.toFixed(1)}%`);
  if (mc) reasons.push(`Monte Carlo: 5% skenario terburuk ${mc.p5ReturnPct.toFixed(1)}%, DD terburuk 5% ${mc.p95MaxDDPct.toFixed(1)}%`);
  if (oos.returnPct < buyHoldPct) reasons.push(`Kalah dari hold spot (${oos.returnPct.toFixed(1)}% vs ${buyHoldPct.toFixed(1)}%) di rentang yang sama`);
  return pass
    ? { level: "kandidat_paper", label: "Kandidat paper trading", reasons }
    : { level: "edge_tipis", label: "Edge tipis, belum layak", reasons };
}
