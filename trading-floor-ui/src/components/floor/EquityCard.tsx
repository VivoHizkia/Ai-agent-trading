"use client";

import type { EquityView, PositionView, PriceView } from "@/lib/types";
import { pct, usd, wib } from "./format";

/** PnL mengambang posisi terbuka, dihitung dari harga publik terbaru (tanpa API key). */
export function floatingPnl(positions: PositionView[], prices: PriceView[]): number | null {
  let total = 0, known = false;
  for (const p of positions) {
    const px = prices.find(x => x.symbol === p.symbol)?.last;
    if (px == null) continue;
    known = true;
    total += (px - p.entry) * p.qty * (p.side === "long" ? 1 : -1);
  }
  return known ? total : null;
}

const signed = (n: number) => `${n >= 0 ? "+" : "−"}${usd(Math.abs(n))}`;

export default function EquityCard({ eq, positions, prices }: { eq: EquityView | null; positions: PositionView[]; prices: PriceView[] }) {
  const floating = floatingPnl(positions, prices);
  if (!eq) {
    return (
      <div className="sec">
        <h3>Equity live</h3>
        <div className="empty">
          <b>Menunggu data equity dari bot.</b>
          <p>bot.ts sekarang mencatat equity ke <code>office/execution/equity.jsonl</code>. Restart bot (<code>npm run bot</code>) supaya pencatatan aktif. Titik pertama muncul saat bar close berikutnya, atau tiap N menit kalau <code>EQUITY_SNAPSHOT_MINUTES</code> diisi di <code>.env</code> engine.</p>
        </div>
      </div>
    );
  }

  const up = (eq.dayChange ?? 0) >= 0;
  const W = 340, H = 120, PAD = 6;
  const vals = eq.points.map(p => p.equity);
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || Math.max(1, max * 0.01);
  const xs = (i: number) => PAD + (vals.length <= 1 ? (W - 2 * PAD) / 2 : (i / (vals.length - 1)) * (W - 2 * PAD));
  const ys = (v: number) => PAD + (1 - (v - min) / span) * (H - 2 * PAD);
  const line = vals.map((v, i) => `${i ? "L" : "M"}${xs(i).toFixed(1)},${ys(v).toFixed(1)}`).join(" ");
  const area = vals.length > 1 ? `${line} L${xs(vals.length - 1).toFixed(1)},${H} L${xs(0).toFixed(1)},${H} Z` : "";
  const trendUp = vals.length > 1 ? vals.at(-1)! >= vals[0]! : up;
  const col = trendUp ? "var(--ok)" : "var(--bad)";

  const BW = 340, BH = 80;
  const dmax = Math.max(0.01, ...eq.daily.map(d => Math.abs(d.pnl)));
  const bw = BW / Math.max(eq.daily.length, 7);

  return (
    <div className="sec">
      <h3>Equity live · {eq.mode}</h3>
      <div className="eq-head">
        <div>
          <div className="eq-big">{usd(eq.last)}</div>
          <div className="fine-inline">update {wib(eq.lastAt)} · {eq.count} titik tercatat</div>
          {eq.netTransfers ? <div className="fine-inline">{eq.netTransfers > 0 ? "Deposit" : "Penarikan"} {signed(eq.netTransfers)} tidak dihitung sebagai untung/rugi</div> : null}
        </div>
        <div className={`eq-chg ${up ? "up" : "dn"}`}>
          {up ? "▲" : "▼"} {eq.dayChange != null ? signed(eq.dayChange) : "-"}
          <small>{pct(eq.dayChangePct, true)} hari ini</small>
        </div>
      </div>
      {floating != null && positions.length > 0 && (
        <p className={`fine-inline ${floating >= 0 ? "up" : "dn"}`}>PnL mengambang posisi terbuka: {signed(floating)} (dari harga terbaru, belum masuk equity tercatat)</p>
      )}
      <svg className="eq-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Grafik equity 7 hari, terakhir ${usd(eq.last)}`}>
        <defs>
          <linearGradient id="eqfill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={col} stopOpacity="0.35" />
            <stop offset="1" stopColor={col} stopOpacity="0" />
          </linearGradient>
        </defs>
        {eq.dayStart != null && <line x1="0" x2={W} y1={ys(eq.dayStart)} y2={ys(eq.dayStart)} stroke="var(--line)" strokeDasharray="3 4" />}
        {area && <path d={area} fill="url(#eqfill)" />}
        <path d={line} fill="none" stroke={col} strokeWidth="2" vectorEffect="non-scaling-stroke" />
        {vals.length > 0 && <circle cx={xs(vals.length - 1)} cy={ys(vals.at(-1)!)} r="3" fill={col} />}
      </svg>
      <div className="eq-axis fine-inline"><span>{wib(eq.points[0]?.t)}</span><span>min {usd(min)} · max {usd(max)}</span></div>

      <h3>Pendapatan per hari</h3>
      <svg className="eq-bars" viewBox={`0 0 ${BW} ${BH}`} preserveAspectRatio="none" role="img" aria-label="Perubahan equity per hari">
        <line x1="0" x2={BW} y1={BH / 2} y2={BH / 2} stroke="var(--line)" />
        {eq.daily.map((d, i) => {
          const h = (Math.abs(d.pnl) / dmax) * (BH / 2 - 4);
          return (
            <rect key={d.day} x={i * bw + bw * 0.18} width={bw * 0.64} y={d.pnl >= 0 ? BH / 2 - h : BH / 2} height={Math.max(1, h)}
              fill={d.pnl >= 0 ? "var(--ok)" : "var(--bad)"}><title>{`${d.day}: ${signed(d.pnl)}`}</title></rect>
          );
        })}
      </svg>
      <div className="eq-days">
        {eq.daily.slice(-5).reverse().map(d => (
          <span key={d.day} className={d.pnl >= 0 ? "up" : "dn"}>{d.day.slice(5)} {signed(d.pnl)}</span>
        ))}
      </div>
      <p className="fine-inline">Dihitung dari perubahan equity akun (sudah termasuk fee &amp; funding). Deposit/withdraw juga ikut terhitung sebagai perubahan.</p>
    </div>
  );
}
