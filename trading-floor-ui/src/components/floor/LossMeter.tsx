"use client";

import type { AccountView, EquityView } from "@/lib/types";
import { usd } from "./format";

/** Seberapa jauh rugi hari ini dari batas rugi harian Risk Engine. 0..100+ persen dari batas. */
export function lossUsage(eq: EquityView | null, limitPct: number): { used: number; level: "aman" | "waspada" | "bahaya"; lossPct: number } | null {
  const changePct = eq?.dayReset?.changePct ?? eq?.dayChangePct;
  if (!eq || changePct == null) return null;
  const lossPct = Math.max(0, -changePct);
  const used = limitPct > 0 ? (lossPct / limitPct) * 100 : 0;
  return { used, lossPct, level: used >= 85 ? "bahaya" : used >= 50 ? "waspada" : "aman" };
}

export default function LossMeter({ eq, account }: { eq: EquityView | null; account: AccountView }) {
  const limit = account.dailyLossPct;
  const u = lossUsage(eq, limit);
  if (!eq || !u) {
    return (
      <div className="sec">
        <h3>Meteran rugi harian</h3>
        <p className="muted-p">Menunggu data equity dari bot (<code>execution/equity.jsonl</code>). Restart bot supaya pencatatan aktif.</p>
      </div>
    );
  }
  const start = eq.dayReset?.start ?? eq.dayStart ?? eq.last;
  const change = eq.dayReset?.change ?? eq.dayChange ?? 0;
  const resetAt = eq.dayReset ? new Date(Date.parse(eq.dayReset.at) + 7 * 3_600_000).toISOString().slice(11, 16) : null;
  const limitUsd = start * limit / 100;
  const lossUsd = Math.max(0, -change);
  const left = Math.max(0, limitUsd - lossUsd);
  const width = Math.min(100, u.used);
  return (
    <div className="sec">
      <h3>Meteran rugi harian</h3>
      <div className={`meter ${u.level}`} role="meter" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={Number(u.lossPct.toFixed(2))} aria-label={`Rugi hari ini ${u.lossPct.toFixed(1)}% dari batas ${limit}%`}>
        <div className="meter-fill" style={{ width: `${width}%` }} />
        <span className="meter-tick" style={{ left: "50%" }} />
        <span className="meter-tick" style={{ left: "85%" }} />
      </div>
      <div className="meter-legend">
        <span className={`meter-badge ${u.level}`}>{u.level === "aman" ? "Aman" : u.level === "waspada" ? "Waspada" : "Bahaya"}</span>
        <span>
          {change >= 0
            ? <>{resetAt ? `Sejak reset ${resetAt}` : "Hari ini"} untung <b className="up">+{usd(change)}</b></>
            : <>Rugi {resetAt ? `sejak reset ${resetAt}` : "hari ini"} <b className="dn">−{usd(lossUsd)}</b> ({u.lossPct.toFixed(1)}% dari {limit}%)</>}
        </span>
      </div>
      <p className="fine-inline">Batas {limit}% = {usd(limitUsd)} dari equity {resetAt ? `saat reset ${resetAt} WIB` : "awal hari"} {usd(start)}. Sisa ruang rugi {usd(left)}. Kalau batas tercapai, Risk Engine menolak entry baru sampai besok.</p>
    </div>
  );
}
