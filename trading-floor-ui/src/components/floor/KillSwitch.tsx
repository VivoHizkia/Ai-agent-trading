"use client";

import { useState } from "react";
import { wib } from "./format";

export default function KillSwitch({ active, since, onDone, onToast }: { active: boolean; since: string | null; onDone: () => void; onToast: (m: string) => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  if (active) {
    return (
      <div className="ks on">
        <b>Kill switch aktif</b> sejak {wib(since)}. Bot berhenti di tick berikutnya.
        <p className="fine-inline">Untuk menyalakan lagi, hapus <code>office/execution/STOP</code> secara manual.</p>
      </div>
    );
  }

  async function fire() {
    setBusy(true);
    try {
      const res = await fetch("/api/office/kill-switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ konfirmasi: "STOP" }),
      });
      onToast(res.ok ? "Kill switch dinyalakan. Bot berhenti di tick berikutnya." : "Gagal membuat file STOP");
      onDone();
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <div className="ks">
      {!confirming ? (
        <button className="btn no" onClick={() => setConfirming(true)}>Kill switch: hentikan bot</button>
      ) : (
        <div className="ks-confirm" role="alertdialog" aria-label="Konfirmasi kill switch">
          <p>Buat file <code>execution/STOP</code>? Bot berhenti membuka posisi baru di tick berikutnya. SL/TP yang sudah terpasang di exchange tetap ada.</p>
          <div className="actions-inline">
            <button className="btn no" disabled={busy} onClick={fire}>Ya, hentikan</button>
            <button className="btn" disabled={busy} onClick={() => setConfirming(false)}>Batal</button>
          </div>
        </div>
      )}
    </div>
  );
}
