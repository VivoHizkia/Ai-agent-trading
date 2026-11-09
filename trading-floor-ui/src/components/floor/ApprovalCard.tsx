"use client";

import { useState } from "react";
import type { ApprovalView } from "@/lib/types";
import { price, usd, wib } from "./format";

const STATUS_TXT: Record<ApprovalView["status"], string> = {
  pending: "Menunggu izin",
  approved: "Diizinkan",
  rejected: "Ditolak",
  expired: "Kedaluwarsa",
};

export default function ApprovalCard({ a, onDecided, onToast }: { a: ApprovalView; onDecided: () => void; onToast: (m: string) => void }) {
  const [note, setNote] = useState(a.catatanBos);
  const [busy, setBusy] = useState(false);
  const isP = a.status === "pending";

  async function decide(status: "approved" | "rejected") {
    setBusy(true);
    try {
      const res = await fetch(`/api/office/approvals/${encodeURIComponent(a.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, catatanBos: note }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) onToast(j.error ?? "Gagal menyimpan keputusan");
      else onToast(`${a.symbol} ${a.side.toUpperCase()} ${status === "approved" ? "diizinkan" : "ditolak"}. Status file approval diperbarui.`);
      onDecided();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`apv ${a.status}`}>
      <div className="apv-head">
        <span className="pair">{a.symbol}</span>
        <span className={`side ${a.side}`}>{a.side.toUpperCase()}</span>
        <span className={`pill ${a.status}`}>{STATUS_TXT[a.status]}</span>
      </div>
      <dl className="kv">
        <div><dt>TF · strategi</dt><dd>{a.tf} · {a.strategyId}</dd></div>
        <div><dt>Stop loss</dt><dd>{price(a.stop)}</dd></div>
        <div><dt>Take profit</dt><dd>{price(a.target)}</dd></div>
        <div><dt>Qty</dt><dd>{a.qty ?? "-"}</dd></div>
        <div><dt>Leverage</dt><dd>{a.leverage != null ? `${a.leverage}x` : "-"}</dd></div>
        <div><dt>Risk</dt><dd>{usd(a.riskUsd)}</dd></div>
      </dl>
      <div className="why">
        <h3>Alasan · dari bot (sinyal + Risk Engine)</h3>
        <p>{a.reason || "-"}</p>
        {!isP && a.catatanBos && (<><h3>Catatan kamu</h3><p>{a.catatanBos}</p></>)}
      </div>
      {isP ? (
        <>
          <div className="edit">
            <label className="field wide">
              Catatan kamu (opsional)
              <textarea rows={2} value={note} maxLength={500} onChange={e => setNote(e.target.value)} placeholder="Misal: oke, tapi cek lagi sebelum berita" />
            </label>
          </div>
          <div className="actions">
            <button className="btn go" disabled={busy} onClick={() => decide("approved")}>Izinkan</button>
            <button className="btn no" disabled={busy} onClick={() => decide("rejected")}>Tolak</button>
          </div>
        </>
      ) : (
        <p className="fine">Diputuskan {wib(a.decidedAt)}.</p>
      )}
      <p className="fine">
        Dibuat {wib(a.createdAt)}. Tombol ini hanya mengubah status file approval. App ini tidak pernah mengirim order; bot.ts yang membaca keputusanmu.
      </p>
    </div>
  );
}
