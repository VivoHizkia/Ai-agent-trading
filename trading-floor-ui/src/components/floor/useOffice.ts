"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PriceView, Snapshot } from "@/lib/types";

const FALLBACK_POLL_MS = 20_000;
const MARKET_POLL_MS = 15_000;

/** Snapshot office/ + harga. Diperbarui lewat SSE (file berubah) dengan polling sebagai cadangan. */
export function useOffice() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [prices, setPrices] = useState<PriceView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const inflight = useRef(false);
  const again = useRef(false);

  const refresh = useCallback(async () => {
    if (inflight.current) { again.current = true; return; }
    inflight.current = true;
    try {
      const res = await fetch("/api/office/snapshot", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSnap(await res.json());
      setError(null);
    } catch (e) {
      setError(`Gagal memuat data office: ${(e as Error).message}`);
    } finally {
      inflight.current = false;
      if (again.current) { again.current = false; void refresh(); }
    }
  }, []);

  const refreshPrices = useCallback(async () => {
    try {
      const res = await fetch("/api/market", { cache: "no-store" });
      if (res.ok) setPrices((await res.json()).prices ?? []);
    } catch { /* ticker tetap pakai harga terakhir */ }
  }, []);

  useEffect(() => {
    void refresh();
    void refreshPrices();
    const poll = setInterval(refresh, FALLBACK_POLL_MS);
    const mpoll = setInterval(refreshPrices, MARKET_POLL_MS);
    let es: EventSource | null = null;
    try {
      es = new EventSource("/api/office/events");
      es.onopen = () => setLive(true);
      es.onerror = () => setLive(false);
      es.onmessage = ev => {
        try {
          const data = JSON.parse(ev.data) as { type: string };
          if (data.type === "change") void refresh();
        } catch { /* abaikan */ }
      };
    } catch { /* tanpa SSE, polling tetap jalan */ }
    return () => { clearInterval(poll); clearInterval(mpoll); es?.close(); };
  }, [refresh, refreshPrices]);

  return { snap, prices, error, live, refresh };
}
