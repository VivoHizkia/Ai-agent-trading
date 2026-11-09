"use client";

import { useEffect, useRef, useState } from "react";
import type { Snapshot } from "@/lib/types";

// Bunyi + notifikasi browser untuk kejadian penting di log bot. Hanya berjalan saat dashboard terbuka;
// untuk kabar saat dashboard tertutup, pakai `npm run notify` (Telegram) di engine.

type Kind = "good" | "info" | "attention" | "alarm";
const RULES: { re: RegExp; kind: Kind; title: string }[] = [
  { re: /KRITIS|FATAL/, kind: "alarm", title: "KRITIS di bot" },
  { re: /GAGAL|ERROR/, kind: "alarm", title: "Error di bot" },
  { re: /Kill switch terdeteksi/, kind: "alarm", title: "Kill switch: bot berhenti" },
  { re: /LIVE entry/, kind: "good", title: "Entry baru (LIVE)" },
  { re: /LIVE tutup posisi|sudah tertutup di exchange/, kind: "info", title: "Posisi tertutup" },
  { re: /menunggu approval manusia/, kind: "attention", title: "Butuh izin Bos" },
];

const TONES: Record<Kind, [number, number][]> = {
  good: [[660, 0.12], [880, 0.18]],
  info: [[740, 0.15], [587, 0.2]],
  attention: [[880, 0.12], [880, 0.12], [1046, 0.2]],
  alarm: [[440, 0.18], [330, 0.18], [440, 0.18], [330, 0.25]],
};

let audioCtx: AudioContext | null = null;
export function playTone(kind: Kind) {
  try {
    audioCtx ??= new AudioContext();
    const ctx = audioCtx;
    let t = ctx.currentTime + 0.02;
    for (const [freq, dur] of TONES[kind]) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = kind === "alarm" ? "square" : "sine";
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(kind === "alarm" ? 0.08 : 0.15, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(ctx.destination);
      o.start(t); o.stop(t + dur + 0.02);
      t += dur + 0.04;
    }
  } catch { /* audio tidak tersedia */ }
}

const KEY = "tf-alerts-on";

export function useAlerts(snap: Snapshot | null, onToast: (m: string) => void) {
  const [on, setOn] = useState(false);
  const lastSeen = useRef<string | null>(null);
  const lastPending = useRef<number | null>(null);

  useEffect(() => {
    try { setOn(localStorage.getItem(KEY) === "1"); } catch { /* storage diblokir */ }
  }, []);

  const toggle = async () => {
    const next = !on;
    setOn(next);
    try { localStorage.setItem(KEY, next ? "1" : "0"); } catch { /* abaikan */ }
    if (next) {
      playTone("good"); // sekaligus membuka izin audio browser lewat klik
      if (typeof Notification !== "undefined" && Notification.permission === "default") {
        try { await Notification.requestPermission(); } catch { /* abaikan */ }
      }
    }
  };

  useEffect(() => {
    if (!snap) return;
    const lines = [...snap.execution.lastLog].sort((a, b) => a.t.localeCompare(b.t));
    const pending = snap.approvals.filter(a => a.status === "pending").length;
    // Saat pertama dimuat: tandai yang sudah ada sebagai "sudah dilihat", jangan berbunyi.
    if (lastSeen.current === null) {
      lastSeen.current = lines.at(-1)?.t ?? "";
      lastPending.current = pending;
      return;
    }
    const fresh = lines.filter(l => l.t > lastSeen.current!);
    if (fresh.length) lastSeen.current = fresh.at(-1)!.t;
    const events: { kind: Kind; title: string; body: string }[] = [];
    for (const l of fresh) {
      const r = RULES.find(x => x.re.test(l.msg));
      if (r) events.push({ kind: r.kind, title: r.title, body: l.msg });
    }
    if (pending > (lastPending.current ?? 0) && !events.some(e => e.kind === "attention")) {
      events.push({ kind: "attention", title: "Butuh izin Bos", body: `${pending} approval menunggu di Ruang Bos` });
    }
    lastPending.current = pending;
    if (!events.length || !on) return;

    const order: Kind[] = ["alarm", "attention", "good", "info"];
    const top = [...events].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))[0]!;
    playTone(top.kind);
    onToast(`${top.title}: ${top.body}`);
    if (typeof Notification !== "undefined" && Notification.permission === "granted" && document.visibilityState !== "visible") {
      for (const e of events.slice(0, 3)) {
        try { new Notification(`Trading Floor · ${e.title}`, { body: e.body, tag: `tf-${e.title}` }); } catch { /* abaikan */ }
      }
    }
  }, [snap, on, onToast]);

  return { on, toggle };
}
