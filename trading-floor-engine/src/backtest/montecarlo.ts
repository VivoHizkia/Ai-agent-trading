// Monte Carlo: acak ulang urutan hasil trade (dalam R) untuk melihat sebaran drawdown dan hasil akhir
// kalau urutan nasibnya berbeda. Satu kurva equity backtest hanyalah satu kemungkinan.
import { rng } from "../data/synthetic.js";

export interface MonteCarloResult {
  sims: number;
  trades: number;
  medianReturnPct: number;
  p5ReturnPct: number; // 5% skenario terburuk berakhir di bawah ini
  medianMaxDDPct: number;
  p95MaxDDPct: number; // 5% skenario terburuk punya drawdown lebih dalam dari ini
  probLossPct: number;
  probDD20Pct: number;
}

export function monteCarlo(rs: number[], riskPct = 1, sims = 2000, seed = 1): MonteCarloResult | null {
  if (rs.length < 5) return null;
  const r = rng(seed);
  const finals: number[] = [], dds: number[] = [];
  for (let s = 0; s < sims; s++) {
    let eq = 1, peak = 1, mdd = 0;
    for (let k = 0; k < rs.length; k++) {
      const x = rs[Math.floor(r() * rs.length)]!;
      eq *= Math.max(0, 1 + (x * riskPct) / 100);
      peak = Math.max(peak, eq);
      mdd = Math.min(mdd, eq / peak - 1);
    }
    finals.push(eq - 1); dds.push(mdd);
  }
  const q = (xs: number[], p: number) => { const a = [...xs].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))]!; };
  return {
    sims, trades: rs.length,
    medianReturnPct: q(finals, 0.5) * 100,
    p5ReturnPct: q(finals, 0.05) * 100,
    medianMaxDDPct: q(dds, 0.5) * 100,
    p95MaxDDPct: q(dds, 0.05) * 100,
    probLossPct: (finals.filter(x => x < 0).length / sims) * 100,
    probDD20Pct: (dds.filter(x => x <= -0.2).length / sims) * 100,
  };
}
