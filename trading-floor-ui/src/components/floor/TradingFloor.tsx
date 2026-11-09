"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ROOMS, ROSTER, resolveWho, type AgentSlug, type RoomId } from "@/lib/roster";
import type { AgentView } from "@/lib/types";
import { DEMO, DEMO_START } from "./demo";
import { nowWib, pct, price, usd, wib } from "./format";
import Markdown from "./Markdown";
import { floatingPnl } from "./EquityCard";
import { lossUsage } from "./LossMeter";
import Panel, { type PanelView } from "./Panel";
import { FloorScene, type LightMode, type SceneData, type Who } from "./scene";
import { useOffice } from "./useOffice";
import { useAlerts } from "./alerts";

const DEMO_MS = 6500;

export default function TradingFloor() {
  const { snap, prices, error, live, refresh } = useOffice();
  const [room, setRoom] = useState<RoomId>("lobby");
  const [view, setView] = useState<PanelView>({ kind: "room", room: "bos" });
  const [sheetOpen, setSheetOpen] = useState(false);
  const [demoOn, setDemoOn] = useState<boolean | null>(null);
  const [demoAgents, setDemoAgents] = useState<AgentView[]>(() => initialDemo());
  const [demoLog, setDemoLog] = useState<{ t: string; who: string; text: string }[]>([]);
  const [light, setLight] = useState<LightMode>("auto");
  const [toast, setToast] = useState<string | null>(null);
  const [report, setReport] = useState<{ name: string; text: string | null } | null>(null);
  const [clock, setClock] = useState("--:-- WIB");
  const [isFs, setIsFs] = useState(false);
  const stageRef = useRef<HTMLElement>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<FloorScene | null>(null);
  const seenMsgs = useRef<Set<string> | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Layar penuh: kantor + panel (panel jadi laci di kanan). Esc atau tombol untuk keluar, F untuk masuk/keluar.
  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await stageRef.current?.requestFullscreen({ navigationUI: "hide" });
    } catch { /* browser menolak, abaikan */ }
  }, []);

  useEffect(() => {
    const onChange = () => { const fs = document.fullscreenElement === stageRef.current; setIsFs(fs); if (fs) setSheetOpen(false); };
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "f" || e.key === "F") { e.preventDefault(); void toggleFullscreen(); }
    };
    document.addEventListener("fullscreenchange", onChange);
    window.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("fullscreenchange", onChange); window.removeEventListener("keydown", onKey); };
  }, [toggleFullscreen]);

  const showToast = useCallback((m: string) => {
    setToast(m);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4200);
  }, []);

  const alerts = useAlerts(snap, showToast);

  const goRoom = useCallback((id: RoomId) => {
    setRoom(id);
    sceneRef.current?.setRoom(id);
    sceneRef.current?.setSelected(null);
    setView({ kind: "room", room: id });
  }, []);

  // Canvas dibuat sekali.
  useEffect(() => {
    if (!canvasRef.current || !wrapRef.current) return;
    const scene = new FloorScene(canvasRef.current, wrapRef.current, {
      onSelect: (who: Who) => { scene.setSelected(who); setView({ kind: "agent", slug: who }); setSheetOpen(true); },
      onOpenApproval: () => { goRoom("bos"); setSheetOpen(true); },
      onRoom: (id: RoomId) => goRoom(id),
    });
    sceneRef.current = scene;
    return () => { scene.destroy(); sceneRef.current = null; };
  }, [goRoom]);

  useEffect(() => { sceneRef.current?.setLight(light); }, [light]);

  // Jam WIB.
  useEffect(() => {
    const tick = () => setClock(nowWib());
    tick();
    const id = setInterval(tick, 15_000);
    return () => clearInterval(id);
  }, []);

  // Demo default nyala hanya kalau office/ kosong atau tidak ada.
  useEffect(() => {
    if (snap && demoOn === null) setDemoOn(!snap.officeOk || snap.officeEmpty);
  }, [snap, demoOn]);

  // Skrip demo (visual saja, tidak menulis file).
  useEffect(() => {
    if (!demoOn) return;
    let step = 0;
    const id = setInterval(() => {
      const s = DEMO[step % DEMO.length]!;
      step++;
      setDemoAgents(prev => prev.map(a => {
        const n = s.states[a.slug];
        return n ? { ...a, state: n[0], bubble: n[1], updatedAt: new Date().toISOString() } : a;
      }));
      if (s.message) {
        sceneRef.current?.flyMessage(s.message.from, s.message.to);
        const msg = s.message;
        setDemoLog(prev => [{ t: nowWib().replace(" WIB", ""), who: `${resolveWho(msg.from).nama} → ${resolveWho(msg.to).nama}`, text: msg.subject }, ...prev].slice(0, 30));
      }
    }, DEMO_MS);
    return () => clearInterval(id);
  }, [demoOn]);

  const agents: AgentView[] = useMemo(() => (demoOn ? demoAgents : snap?.agents ?? []), [demoOn, demoAgents, snap]);
  const pendingCount = snap?.approvals.filter(a => a.status === "pending").length ?? 0;

  // Data untuk canvas.
  const sceneData: SceneData = useMemo(() => {
    const ex = snap?.execution;
    const btc = prices.find(p => p.symbol === "BTCUSDT");
    const fundingBtc = btc?.fundingPct ?? snap?.marketSnapshot.rows.find(r => r.symbol === "BTCUSDT")?.fundingRatePct ?? null;
    const top = snap?.scan?.top ?? [];
    return {
      agents: agents.map(a => ({ slug: a.slug, state: a.state, bubble: a.bubble })),
      pendingCount,
      prices: prices.map(p => ({ symbol: p.symbol, last: p.last, chgPct: p.chgPct })),
      fundingBtc,
      equity: snap?.account.equity ?? 0,
      dailyLossPct: snap?.account.dailyLossPct ?? 3,
      exposurePct: ex?.exposurePct ?? null,
      rejectedToday: ex?.rejectedToday ?? 0,
      positions: ex?.positions.map(p => ({ symbol: p.symbol, side: p.side, tf: p.tf })) ?? [],
      mode: demoOn ? "DEMO" : ex?.mode ?? "-",
      autoEntry: ex?.autoEntry ?? false,
      killSwitch: ex?.killSwitch ?? false,
      execStatus: ex?.lastLog[0]?.msg ?? "standby",
      boardTitle: snap?.scan ? `PERINGKAT OOS${snap.scan.synthetic ? " (SINTETIS)" : ""}` : "PAPAN JURNAL",
      board: top.slice(0, 4).map(r => ({ label: `${r.symbol.replace("USDT", "")} ${r.tf}`, ret: r.returnPct, hold: r.holdPct })),
      scanLine: snap?.scan ? `${snap.scan.total} baris · ${snap.scan.kandidat} kandidat · ${wib(snap.scan.createdAt)}` : "",
      eq: {
        last: snap?.equity?.last ?? null,
        change: snap?.equity?.dayChange ?? null,
        changePct: snap?.equity?.dayChangePct ?? null,
        series: snap?.equity?.points.map(p => p.equity) ?? [],
        daily: snap?.equity?.daily.map(d => d.pnl) ?? [],
        mode: snap?.equity?.mode ?? "",
        floating: ex?.positions.length ? floatingPnl(ex.positions, prices) : null,
      },
      lossUsed: snap ? lossUsage(snap.equity, snap.account.dailyLossPct)?.used ?? null : null,
      ops: {
        bot: snap?.ops.bot.status ?? "-",
        notifier: snap?.ops.notifier.status ?? "-",
        errors: snap?.ops.errorsToday ?? 0,
        lastTick: snap?.ops.lastLogAt ? wib(snap.ops.lastLogAt) : "-",
      },
      regime: {
        rows: snap?.regime?.rows.map(r => ({ symbol: r.symbol, label: r.label, regime: r.regime })) ?? [],
        fits: snap?.regime?.fits.map(f => ({ key: `${f.symbol} ${f.tf} ${f.strategyId}`, fit: f.fit })) ?? [],
      },
      news: {
        next: snap?.calendar?.nextHigh ? { title: snap.calendar.nextHigh.title, at: snap.calendar.nextHigh.at } : null,
        near: Boolean(snap?.calendar?.nearHigh),
        upcoming: snap?.calendar?.events.filter(e => Date.parse(e.at) > Date.now()).slice(0, 3).map(e => ({ title: e.title, at: e.at, impact: e.impact })) ?? [],
      },
      labRows: snap?.lab?.rows.map(r => ({ key: `${r.symbol} ${r.tf} ${r.strategyId}`, status: r.status, recentR: r.recent.avgR })) ?? [],
      reviewLines: snap?.review ? [
        `Minggu ${snap.review.week.slice(5)}`,
        `${snap.review.trades.n} trade · win ${snap.review.trades.winRate.toFixed(0)}%`,
        `${snap.review.trades.avgR >= 0 ? "+" : ""}${snap.review.trades.avgR.toFixed(2)}R rata-rata`,
        `PnL ${snap.review.trades.pnl >= 0 ? "+" : "-"}$${Math.abs(snap.review.trades.pnl).toFixed(2)}`,
        `minggu lalu ${snap.review.prev.n} trade`,
      ] : [],
      scalp: snap ? (() => {
        const w1h = snap.execution.watchlist.filter(w => w.tf === "1h");
        const p1h = snap.execution.positions.filter(p => p.tf === "1h");
        const risk = w1h.find(w => w.riskPct)?.riskPct;
        return {
          lines: w1h.length ? w1h.map(w => { const p = p1h.find(x => x.symbol === w.symbol); return `${w.symbol.replace("USDT", "")} 1h · ${p ? `${p.side.toUpperCase()} @ ${p.entry}` : "menunggu sinyal"}`; }) : ["belum ada strategi 1h"],
          verdict: `slot ${p1h.length}/2 · risk ${risk ? `${risk}%` : "-"}`,
          best: snap.scalpHistory.length ? `${snap.scalpHistory.length} uji · ${snap.scalpHistory.filter(h => h.good).length} positif` : "belum ada riset",
        };
      })() : null,
      journalLine: snap?.journal ? `${snap.journal.total} trade · win ${snap.journal.winRate.toFixed(0)}% · ${snap.journal.avgR >= 0 ? "+" : ""}${snap.journal.avgR.toFixed(2)}R` : "",
    };
  }, [agents, prices, snap, pendingCount, demoOn]);

  useEffect(() => { sceneRef.current?.setData(sceneData); }, [sceneData]);

  // Amplop terbang untuk pesan inbox yang baru muncul (bukan pesan lama saat halaman dibuka).
  useEffect(() => {
    if (!snap) return;
    if (seenMsgs.current === null) { seenMsgs.current = new Set(snap.messages.map(m => m.key)); return; }
    for (const m of snap.messages) {
      if (seenMsgs.current.has(m.key)) continue;
      seenMsgs.current.add(m.key);
      const from = resolveWho(m.from).slug, to = resolveWho(m.to).slug;
      if (from && to) sceneRef.current?.flyMessage(from, to);
    }
  }, [snap]);

  async function openReport(name: string) {
    setReport({ name, text: null });
    try {
      const r = await fetch(`/api/office/reports/${encodeURIComponent(name)}`);
      const j = await r.json();
      setReport({ name, text: r.ok ? j.text : j.error ?? "Gagal memuat" });
    } catch {
      setReport({ name, text: "Gagal memuat laporan" });
    }
  }

  const ex = snap?.execution;
  const logItems = useMemo(() => {
    if (demoOn) return demoLog;
    const msgs = (snap?.messages ?? []).map(m => ({ at: m.createdAt, who: `${m.fromName} → ${m.toName}`, text: m.subject }));
    const bot = (snap?.execution.lastLog ?? []).map(l => ({ at: l.t, who: "Bot", text: l.msg }));
    return [...msgs, ...bot].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 40).map(x => ({ t: wib(x.at).replace(" WIB", ""), who: x.who, text: x.text }));
  }, [snap, demoOn, demoLog]);

  const tickerParts = (
    <>
      {prices.map(p => (
        <span key={p.symbol}><b>{p.symbol}</b> {price(p.last)}{" "}
          {p.chgPct != null && <span className={p.chgPct < 0 ? "dn" : "up"}>{pct(p.chgPct, true)}</span>}
          {p.source !== "binance" && <span className="lbl"> ({p.source === "snapshot" ? "snapshot" : "harga terakhir data"})</span>}
        </span>
      ))}
      <span><span className="lbl">Equity</span> <b>{usd(snap?.account.equity)}</b></span>
      <span><span className="lbl">Mode bot</span> <b>{ex?.mode ?? "-"}</b></span>
      <span><span className="lbl">Posisi terbuka</span> <b>{ex?.positions.length ?? 0}</b></span>
      <span><span className="lbl">Approval menunggu</span> <b>{pendingCount}</b></span>
      <span><span className="lbl">Exposure</span> <b>{pct(ex?.exposurePct)}</b></span>
      {snap?.scan && <span><span className="lbl">Scan</span> <b>{snap.scan.kandidat} kandidat</b> <span className="lbl">{wib(snap.scan.createdAt)}</span></span>}
    </>
  );

  return (
    <div className="app">
      <header className="top">
        <div className="brand"><i aria-hidden="true" />Trading Floor</div>
        {demoOn ? <span className="chip mode">DEMO · data contoh</span>
          : <span className={`chip mode ${ex?.mode === "LIVE" ? "live" : ""}`} title="Dibaca dari log bot terakhir">{ex?.mode ?? "…"}</span>}
        {!demoOn && ex?.mode === "LIVE" && ex.autoEntry && <span className="chip warn" title="REQUIRE_APPROVAL=false di engine">Entry otomatis tanpa approval</span>}
        {!demoOn && ex?.killSwitch && <span className="chip bad">Kill switch aktif</span>}
        <span className="chip clock">{clock}</span>
        <span className={`chip live-dot ${live ? "on" : ""}`} title={live ? "Tersambung ke office/ (SSE)" : "Polling tiap 20 detik"}>{live ? "live" : "polling"}</span>
        <span className="spacer" />
        <button className="ctrl" aria-pressed={!!demoOn} onClick={() => setDemoOn(d => { if (!d) setDemoAgents(initialDemo()); return !d; })}>{demoOn ? "Demo: nyala" : "Demo: mati"}</button>
        <button className="ctrl" onClick={() => setLight(l => ({ auto: "malam", malam: "siang", siang: "auto" } as const)[l])}>Lampu: {light}</button>
        <button className="ctrl" aria-pressed={alerts.on} onClick={alerts.toggle} title="Bunyi & notifikasi browser saat entry, posisi tertutup, error, atau butuh izin">{alerts.on ? "🔔 Bunyi: nyala" : "🔕 Bunyi: mati"}</button>
        <button className="ctrl" onClick={toggleFullscreen} title="Layar penuh (F)">⛶ Layar penuh</button>
      </header>

      {(error || (snap?.warnings.length ?? 0) > 0) && (
        <div className="warns">
          {error && <div className="warnbox">{error}</div>}
          {snap?.warnings.map(w => <div className="warnbox" key={w}>{w}</div>)}
        </div>
      )}

      <div className="ticker" aria-label="Ticker pasar"><div className="ticker-track">{tickerParts}{tickerParts}</div></div>

      <nav className="tabs" role="tablist" aria-label="Ruangan">
        {ROOMS.map(r => (
          <button key={r.id} className="tab" role="tab" aria-selected={r.id === room} onClick={() => { goRoom(r.id); if (r.id === "bos") setSheetOpen(true); }}>
            {r.name}
            {r.id === "bos" && pendingCount > 0 && <span className="badge" aria-label={`${pendingCount} approval menunggu`}>{pendingCount}</span>}
          </button>
        ))}
      </nav>

      <main className={`stage ${isFs ? "fs" : ""}`} ref={stageRef}>
        <div className="floor-wrap" ref={wrapRef}>
          <canvas ref={canvasRef} tabIndex={0} aria-label="Kantor isometrik. Klik karakter untuk membuka catatannya." />
          {!isFs && <div className="hint">Klik karakter untuk lihat catatan · geser untuk pindah · scroll untuk zoom · F layar penuh</div>}
          {isFs ? (
            <div className="fs-bar">
              <div className="brand small"><i aria-hidden="true" />Trading Floor</div>
              <nav className="fs-tabs" role="tablist" aria-label="Ruangan">
                {ROOMS.map(r => (
                  <button key={r.id} className="tab" role="tab" aria-selected={r.id === room} onClick={() => goRoom(r.id)}>
                    {r.name}
                    {r.id === "bos" && pendingCount > 0 && <span className="badge">{pendingCount}</span>}
                  </button>
                ))}
              </nav>
              <span className="chip clock">{clock}</span>
              {!demoOn && ex && <span className={`chip mode ${ex.mode === "LIVE" ? "live" : ""}`}>{ex.mode}</span>}
              {snap?.equity && <span className={`chip ${(snap.equity.dayChange ?? 0) >= 0 ? "eq-up" : "eq-dn"}`}>{usd(snap.equity.last)} {(snap.equity.dayChange ?? 0) >= 0 ? "▲" : "▼"} {pct(snap.equity.dayChangePct, true)}</span>}
              <button className="ctrl" onClick={() => setSheetOpen(o => !o)}>{sheetOpen ? "Tutup panel" : "Panel"}</button>
              <button className="ctrl" onClick={toggleFullscreen} title="Keluar layar penuh (Esc)">Keluar ✕</button>
            </div>
          ) : (
            <button className="fs-btn" onClick={toggleFullscreen} title="Layar penuh (F)" aria-label="Layar penuh">⛶</button>
          )}
        </div>
        <Panel
          view={view}
          snap={snap}
          agents={agents}
          prices={prices}
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          onRefresh={refresh}
          onToast={showToast}
          onOpenRoom={id => { goRoom(id); setSheetOpen(true); }}
          onOpenReport={openReport}
        />
      </main>

      <section className="log" aria-label="Log kantor">
        <h2>Log Kantor</h2>
        <ol>
          {logItems.map((l, i) => (
            <li key={i}><time>{l.t}</time><span className="who-to">{l.who}</span><span className="txt">{l.text}</span></li>
          ))}
          {!logItems.length && <li><span className="txt">Belum ada aktivitas.</span></li>}
        </ol>
      </section>

      {toast && <div className="toast" role="status">{toast}</div>}

      {report && (
        <div className="modal-backdrop" onClick={() => setReport(null)}>
          <div className="modal" role="dialog" aria-label={report.name} onClick={e => e.stopPropagation()}>
            <div className="modal-head"><b>{report.name}</b><button className="ctrl" onClick={() => setReport(null)}>Tutup</button></div>
            {report.text == null ? <p className="muted-p">Memuat…</p> : <Markdown text={report.text} />}
          </div>
        </div>
      )}
    </div>
  );
}

function initialDemo(): AgentView[] {
  return ROSTER.map(r => {
    const [state, bubble] = DEMO_START[r.slug as AgentSlug];
    return { slug: r.slug, state, bubble, updatedAt: null, source: "default" as const };
  });
}
