"use client";

import type { JournalView, StrategyJournal } from "@/lib/types";
import { price, usd, wib } from "./format";

const signedUsd = (n: number) => `${n >= 0 ? "+" : "−"}${usd(Math.abs(n))}`;
const signedR = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}R`;

const STATUS_CLASS: Record<StrategyJournal["status"], string> = {
  "sampel kecil": "neutral",
  "sesuai backtest": "ok",
  "di atas backtest": "ok",
  "di bawah backtest": "bad",
  "tanpa data backtest": "neutral",
};

export default function JournalSection({ j }: { j: JournalView | null }) {
  if (!j) {
    return (
      <div className="sec">
        <h3>Jurnal trade live</h3>
        <div className="empty">
          <b>Belum ada trade yang tertutup.</b>
          <p>bot.ts sekarang mencatat setiap posisi yang tertutup ke <code>execution/trades.jsonl</code> (harga exit, PnL setelah fee &amp; funding, dan R). Restart bot supaya aktif. Trade pertama muncul di sini setelah posisi pertama selesai.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="sec">
      <h3>Jurnal trade live · {j.mode}</h3>
      <div className="stats four">
        <div className="stat"><span>Trade</span><b>{j.total}</b></div>
        <div className="stat"><span>Win rate</span><b>{j.winRate.toFixed(0)}%</b></div>
        <div className="stat"><span>Rata-rata</span><b className={j.avgR >= 0 ? "up" : "dn"}>{signedR(j.avgR)}</b></div>
        <div className="stat"><span>Total PnL</span><b className={j.totalPnl >= 0 ? "up" : "dn"}>{signedUsd(j.totalPnl)}</b></div>
      </div>

      <h3>Live vs backtest</h3>
      <div className="tbl-wrap">
        <table className="tbl scan">
          <thead><tr><th>Strategi</th><th>Live</th><th>Backtest (OOS)</th><th>Status</th></tr></thead>
          <tbody>
            {j.byStrategy.map(s => (
              <tr key={`${s.symbol}${s.tf}${s.strategyId}`}>
                <td className="wrap"><b>{s.symbol.replace("USDT", "")} {s.tf}</b><small>{s.strategyId}</small></td>
                <td>{s.n} trade<small>win {s.winRate.toFixed(0)}% · {signedR(s.avgR)}</small></td>
                <td>{s.bt ? <>{s.bt.trades ?? "-"} trade<small>win {s.bt.winPct ?? "-"}% · {s.bt.expR != null ? signedR(s.bt.expR) : "-"}</small></> : <small>tidak ada di scan</small>}</td>
                <td><span className={`status-chip ${STATUS_CLASS[s.status]}`}>{s.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="fine-inline">Dibandingkan dengan scan terakhir {j.byStrategy.find(s => s.bt)?.bt?.file ?? ""}. Status baru dinilai setelah 10 trade per strategi; di bawah itu terlalu sedikit untuk disimpulkan.</p>

      <h3>Trade terakhir</h3>
      <ul className="trades">
        {j.recent.map(t => (
          <li key={t.key}>
            <div className="trade-top">
              <b>{t.symbol.replace("USDT", "")} {t.tf}</b>
              <span className={`side ${t.side}`}>{t.side.toUpperCase()}</span>
              <span className={t.pnl >= 0 ? "up" : "dn"}>{signedUsd(t.pnl)} · {signedR(t.r)}</span>
              <time>{wib(t.t)}</time>
            </div>
            <div className="fine-inline">{price(t.entry)} → {price(t.exit)} · {t.reason}{t.holdHours != null ? ` · ${t.holdHours < 48 ? `${t.holdHours.toFixed(1)} jam` : `${(t.holdHours / 24).toFixed(1)} hari`}` : ""} · fee {usd(-t.fees)}{t.source ? ` · ${t.source}` : ""}</div>
            {t.crowd && <div className="fine-inline crowd-ctx">Saat entry: {t.crowd}</div>}
          </li>
        ))}
      </ul>
    </div>
  );
}
