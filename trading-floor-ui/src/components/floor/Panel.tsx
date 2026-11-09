"use client";

import { useEffect, useState } from "react";
import { ROSTER, ROOMS, STATE_LABEL, type AgentSlug, type RoomId } from "@/lib/roster";
import type { AgentDetail, AgentView, PriceView, Snapshot } from "@/lib/types";
import ApprovalCard from "./ApprovalCard";
import EquityCard from "./EquityCard";
import JournalSection from "./JournalSection";
import LossMeter from "./LossMeter";
import { LabRoom, NewsRoom, OpsRoom, RegimeRoom, ReviewRoom, ScalpRoom } from "./RoomExtras";
import KillSwitch from "./KillSwitch";
import Markdown from "./Markdown";
import { pct, price, usd, wib } from "./format";

export type PanelView = { kind: "agent"; slug: AgentSlug | "bos" } | { kind: "room"; room: RoomId };

interface Props {
  view: PanelView;
  snap: Snapshot | null;
  agents: AgentView[];
  prices: PriceView[];
  open: boolean;
  onClose: () => void;
  onRefresh: () => void;
  onToast: (m: string) => void;
  onOpenRoom: (room: RoomId) => void;
  onOpenReport: (name: string) => void;
}

export default function Panel(p: Props) {
  const v = p.view;
  return (
    <aside className={`panel ${p.open ? "open" : ""}`} aria-live="polite">
      <button className="close" onClick={p.onClose}>Tutup</button>
      {v.kind === "agent"
        ? v.slug === "bos"
          ? <BossCard onOpen={() => p.onOpenRoom("bos")} />
          : <AgentPanel slug={v.slug} agent={p.agents.find(a => a.slug === v.slug) ?? null} />
        : <RoomPanel {...p} room={v.room} />}
    </aside>
  );
}

function BossCard({ onOpen }: { onOpen: () => void }) {
  return (
    <>
      <div className="who">
        <div className="avatar" style={{ background: "#2f3a56", color: "#fff" }}>V</div>
        <div><h2>Vivo · Bos</h2><p>Pemilik meja approval</p></div>
      </div>
      <p className="muted-p">Aturan risiko hanya bisa diubah Bos lewat <code>src/risk/engine.ts</code>. Agent tidak bisa mengubahnya.</p>
      <button className="link" onClick={onOpen}>Buka meja approval</button>
    </>
  );
}

function AgentPanel({ slug, agent }: { slug: AgentSlug; agent: AgentView | null }) {
  const def = ROSTER.find(r => r.slug === slug)!;
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const updatedAt = agent?.updatedAt;

  useEffect(() => {
    let cancel = false;
    setDetail(null);
    fetch(`/api/office/agents/${slug}`, { cache: "no-store" })
      .then(r => r.json())
      .then(d => { if (!cancel) setDetail(d); })
      .catch(() => { if (!cancel) setDetail({ notes: "", notesFile: null, notesTruncated: false, messages: [] }); });
    return () => { cancel = true; };
  }, [slug, updatedAt]);

  const state = agent?.state ?? "idle";
  return (
    <>
      <div className="who">
        <div className="avatar" style={{ background: def.shirt }}>{def.nama[0]}</div>
        <div>
          <h2>{def.nama} · {def.jabatan}</h2>
          <p>Divisi {def.divisi} · update {wib(agent?.updatedAt)}</p>
        </div>
      </div>
      <div className="row-gap">
        <span className={`state ${state}`}>{STATE_LABEL[state]}</span>
        <span className="src">{agent?.source === "status.json" ? "dari status.json" : agent?.source === "turunan" ? "disimpulkan dari data office/" : "belum ada data"}</span>
      </div>
      <div className="bubble-now">{agent?.bubble || "-"}</div>
      <div className="sec">
        <h3>CATATAN-{def.nama.toUpperCase()}.md</h3>
        {!detail ? <p className="muted-p">Memuat…</p> : detail.notes ? (
          <>
            {detail.notesTruncated && <p className="fine-inline">File besar, ditampilkan bagian akhirnya saja.</p>}
            <Markdown text={detail.notes} />
          </>
        ) : <p className="muted-p">Belum ada catatan. Agent menulisnya di <code>office/agents/{slug}/</code>.</p>}
      </div>
      <div className="sec">
        <h3>Pesan masuk & keluar</h3>
        <ul className="msgs">
          {detail?.messages.length ? detail.messages.map(m => (
            <li key={m.key}>
              <div className="meta"><span>{m.fromName} → {m.toName}</span><time>{wib(m.createdAt)}</time></div>
              <strong>{m.subject}</strong>{m.body}
            </li>
          )) : <li>Belum ada pesan.</li>}
        </ul>
      </div>
    </>
  );
}

function RoomPanel(p: Props & { room: RoomId }) {
  const { snap, prices, room } = p;
  const name = ROOMS.find(r => r.id === room)?.name ?? room;
  if (!snap) return <><h2>{name}</h2><p className="muted-p">Memuat data office…</p></>;
  const ex = snap.execution;
  const acct = snap.account;
  const people = ROSTER.filter(r => {
    const a = p.agents.find(x => x.slug === r.slug);
    if (room === "lounge") return a?.state === "idle";
    if (room === "meeting") return a?.state === "meeting";
    return r.room === room && a?.state !== "idle" && a?.state !== "meeting";
  });

  const roster = people.length > 0 && (
    <div className="sec">
      <h3>Di ruangan ini</h3>
      <div className="people">
        {people.map(r => (
          <span key={r.slug} className="person-chip"><i style={{ background: r.shirt }} />{r.nama} · {r.jabatan}</span>
        ))}
      </div>
    </div>
  );

  switch (room) {
    case "lobby":
      return (
        <>
          <h2>Lobby · Market Hari Ini</h2>
          {roster}
          <div className="sec">
            <h3>Harga</h3>
            {prices.length ? (
              <table className="tbl"><thead><tr><th>Pair</th><th>Harga</th><th>24j</th><th>Funding</th></tr></thead>
                <tbody>{prices.map(x => (
                  <tr key={x.symbol}><td>{x.symbol}</td><td>{price(x.last)}</td>
                    <td className={x.chgPct == null ? "" : x.chgPct < 0 ? "dn" : "up"}>{x.chgPct == null ? "-" : pct(x.chgPct, true)}</td>
                    <td>{x.fundingPct == null ? "-" : `${x.fundingPct.toFixed(4)}%`}</td></tr>))}
                </tbody></table>
            ) : <p className="muted-p">Harga belum tersedia.</p>}
            {prices.some(x => x.source !== "binance") && <p className="fine-inline">Sebagian harga dari snapshot / harga terakhir data, bukan live.</p>}
          </div>
          <Messages snap={snap} />
        </>
      );
    case "riset":
      return (
        <>
          <h2>Ruang Riset</h2>
          {roster}
          <ScanTable snap={snap} limit={10} onOpenReport={p.onOpenReport} />
          <div className="sec">
            <h3>Debat terakhir</h3>
            {snap.debate ? (
              <>
                <div className="stats three">
                  <div className="stat"><span>Go paper</span><b>{snap.debate.goPaper}</b></div>
                  <div className="stat"><span>Watch</span><b>{snap.debate.watch}</b></div>
                  <div className="stat"><span>Reject</span><b>{snap.debate.reject}</b></div>
                </div>
                <p className="fine-inline">{snap.debate.file} · {wib(snap.debate.createdAt)}</p>
              </>
            ) : <p className="muted-p">Belum ada debat. Jalankan <code>npm run debate</code> di engine.</p>}
          </div>
        </>
      );
    case "risk":
      return (
        <>
          <h2>Risk Desk</h2>
          {roster}
          <LossMeter eq={snap.equity} account={acct} />
          <div className="stats">
            <div className="stat"><span>Exposure</span><b>{pct(ex.exposurePct)}</b></div>
            <div className="stat"><span>Posisi terbuka</span><b>{ex.positions.length} / {acct.maxPositions}</b></div>
            <div className="stat"><span>Ditolak hari ini</span><b>{ex.rejectedToday}</b></div>
            <div className="stat"><span>Batas rugi harian</span><b>{usd(acct.equity * acct.dailyLossPct / 100)}</b></div>
          </div>
          <div className="sec"><h3>Kill switch</h3><p className="muted-p">{ex.killSwitch ? `Aktif sejak ${wib(ex.killSwitchAt)}` : "Tidak aktif"}</p></div>
          <Rules snap={snap} />
        </>
      );
    case "exec":
      return (
        <>
          <h2>Execution Room</h2>
          {roster}
          <div className={`mode-badge ${ex.mode === "LIVE" ? "live" : ex.mode === "DRY_RUN" ? "dry" : ""}`}>
            {ex.mode}
            <small>{ex.modeSince ? `sejak ${wib(ex.modeSince)}` : "dari log bot"}</small>
          </div>
          {ex.mode === "LIVE" && ex.autoEntry && <div className="warnbox">REQUIRE_APPROVAL=false: entry baru langsung dieksekusi tanpa izin.</div>}
          <Positions snap={snap} exclude1h />
          <div className="sec">
            <h3>Watchlist 4h · slot {ex.positions.filter(p => p.tf !== "1h").length}/2</h3>
            {ex.watchlist.some(w => w.tf === "1h") && <p className="fine-inline">Strategi 1h ({ex.watchlist.filter(w => w.tf === "1h").map(w => w.symbol.replace("USDT", "")).join(", ")}) punya slot sendiri di Ruang Scalping.</p>}
            <div className="people">{ex.watchlist.filter(w => w.tf !== "1h").length ? ex.watchlist.filter(w => w.tf !== "1h").map(w => <span className="chip" key={`${w.symbol}${w.tf}${w.strategyId}`}>{w.symbol} {w.tf} · {w.strategyId}</span>) : <span className="muted-p">kosong</span>}</div>
            <p className="fine-inline">watchlist.json read-only di UI.</p>
          </div>
          <div className="sec">
            <h3>Log bot terakhir</h3>
            <ol className="loglist">{ex.lastLog.slice(0, 5).map((l, i) => <li key={i}><time>{wib(l.t)}</time> {l.msg}</li>)}{!ex.lastLog.length && <li>Belum ada log.</li>}</ol>
          </div>
        </>
      );
    case "meeting":
      return (
        <>
          <h2>Ruang Meeting</h2>
          {roster || <p className="muted-p">Sepi. Agent pindah ke sini otomatis saat ada debat baru (kurang dari 10 menit).</p>}
          {snap.debate && (
            <div className="sec"><h3>Topik debat terakhir</h3>
              <table className="tbl"><thead><tr><th>Aset</th><th>Strategi</th><th>Vonis</th><th>Yakin</th></tr></thead>
                <tbody>{snap.debate.top.map((d, i) => <tr key={i}><td>{d.symbol} {d.tf}</td><td>{d.strategyId}</td><td>{d.verdict}</td><td>{d.confidence}</td></tr>)}</tbody></table>
            </div>
          )}
        </>
      );
    case "jurnal":
      return (
        <>
          <h2>Ruang Jurnal</h2>
          {roster}
          <JournalSection j={snap.journal} />
          <ScanTable snap={snap} limit={20} showHold onOpenReport={p.onOpenReport} />
        </>
      );
    case "lounge":
      return (
        <>
          <h2>Lounge & Pool</h2>
          {roster || <p className="muted-p">Semua agent sedang kerja.</p>}
          <Messages snap={snap} />
        </>
      );
    case "ops": return <OpsRoom snap={snap} />;
    case "regime": return <RegimeRoom snap={snap} />;
    case "berita": return <NewsRoom snap={snap} />;
    case "lab": return <LabRoom snap={snap} />;
    case "scalp": return <ScalpRoom snap={snap} />;
    case "review": return <ReviewRoom snap={snap} onOpenReport={p.onOpenReport} />;
    case "bos": {
      const pending = snap.approvals.filter(a => a.status === "pending");
      const latest = snap.approvals[0];
      return (
        <>
          <h2>Ruang Bos</h2>
          <EquityCard eq={snap.equity} positions={ex.positions} prices={prices} />
          <LossMeter eq={snap.equity} account={acct} />
          <h3 className="sec-h">Meja approval</h3>
          {pending.length ? pending.map(a => <ApprovalCard key={a.id} a={a} onDecided={p.onRefresh} onToast={p.onToast} />)
            : (
              <>
                <div className="empty">
                  <b>Tidak ada permintaan izin.</b>
                  {ex.autoEntry
                    ? <p>Bot jalan dengan <code>REQUIRE_APPROVAL=false</code>, jadi entry tidak lewat meja ini. Set <code>REQUIRE_APPROVAL=true</code> di engine kalau mau setiap entry minta izin di sini.</p>
                    : <p>Approval muncul di sini saat bot.ts menemukan sinyal dari watchlist yang lolos Risk Engine.</p>}
                </div>
                {latest && <ApprovalCard key={latest.id} a={latest} onDecided={p.onRefresh} onToast={p.onToast} />}
              </>
            )}
          <div className="sec"><h3>Kondisi akun</h3>
            <div className="stats">
              <div className="stat"><span>Equity</span><b>{usd(acct.equity)}</b><em>{acct.equitySource}</em></div>
              <div className="stat"><span>Rugi harian maks</span><b>{usd(acct.equity * acct.dailyLossPct / 100)}</b></div>
              <div className="stat"><span>Posisi terbuka</span><b>{ex.positions.length} / {acct.maxPositions}</b></div>
              <div className="stat"><span>Risk per trade</span><b>{usd(acct.equity * acct.riskPerTradePct / 100)}</b></div>
            </div>
          </div>
          <div className="sec"><h3>Kill switch</h3><KillSwitch active={ex.killSwitch} since={ex.killSwitchAt} onDone={p.onRefresh} onToast={p.onToast} /></div>
          <Rules snap={snap} />
        </>
      );
    }
  }
}

function Rules({ snap }: { snap: Snapshot }) {
  return (
    <div className="sec">
      <h3>Aturan risiko (RISK-RULES.md)</h3>
      {snap.riskRules.length ? (
        <ul className="rules">{snap.riskRules.map(r => <li key={r.aturan}>{r.aturan}: <b>{r.nilai}</b></li>)}</ul>
      ) : <p className="muted-p">RISK-RULES.md tidak ditemukan.</p>}
      <p className="fine-inline">Hanya ditampilkan. Angka ini diubah di <code>src/risk/engine.ts</code>, bukan dari UI.</p>
    </div>
  );
}

function Positions({ snap, exclude1h }: { snap: Snapshot; exclude1h?: boolean }) {
  const ps = exclude1h ? snap.execution.positions.filter(p => p.tf !== "1h") : snap.execution.positions;
  return (
    <div className="sec">
      <h3>Posisi terbuka</h3>
      {ps.length ? (
        <table className="tbl"><thead><tr><th>Aset</th><th>Side</th><th>Entry</th><th>SL</th><th>TP</th><th>Notional</th></tr></thead>
          <tbody>{ps.map(x => <tr key={x.key}><td>{x.symbol} {x.tf}</td><td className={x.side === "long" ? "up" : "dn"}>{x.side.toUpperCase()}</td><td>{price(x.entry)}</td><td>{price(x.stop)}</td><td>{price(x.target)}</td><td>{usd(x.notional)}</td></tr>)}</tbody></table>
      ) : <p className="muted-p">Tidak ada posisi. Lampu merah di Execution Room mati.</p>}
    </div>
  );
}

function ScanTable({ snap, limit, showHold, onOpenReport }: { snap: Snapshot; limit: number; showHold?: boolean; onOpenReport: (n: string) => void }) {
  const s = snap.scan;
  if (!s) return <div className="sec"><h3>Scan terakhir</h3><p className="muted-p">Belum ada scan. Jalankan <code>npm run scan:top30</code> di engine.</p></div>;
  return (
    <div className="sec">
      <h3>Scan terakhir · {wib(s.createdAt)}</h3>
      {s.synthetic && <div className="warnbox">Data sintetis. Hanya menguji mesin, bukan pasar.</div>}
      <p className="fine-inline">{s.total} baris, {s.kandidat} kandidat paper trading. Peringkat out-of-sample.</p>
      <div className="tbl-wrap">
        <table className="tbl scan"><thead><tr><th>#</th><th>Aset · strategi</th><th>OOS</th>{showHold && <th>Hold</th>}<th>PF</th></tr></thead>
          <tbody>{s.top.slice(0, limit).map(r => (
            <tr key={r.rank}><td>{r.rank}</td>
              <td className="wrap"><b>{r.symbol.replace("USDT", "")} {r.tf}</b><small>{r.strategy}</small><small className={/^kandidat/i.test(r.vonis) ? "up" : ""}>{r.vonis}</small></td>
              <td className={r.returnPct == null ? "" : r.returnPct < 0 ? "dn" : "up"}>{pct(r.returnPct, true)}</td>
              {showHold && <td>{pct(r.holdPct, true)}</td>}
              <td>{r.pf}</td></tr>))}
          </tbody></table>
      </div>
      <button className="link" onClick={() => onOpenReport(s.file)}>Buka laporan {s.file}</button>
    </div>
  );
}

function Messages({ snap }: { snap: Snapshot }) {
  return (
    <div className="sec">
      <h3>Pesan antar agent terbaru</h3>
      <ul className="msgs">
        {snap.messages.slice(0, 6).map(m => (
          <li key={m.key}><div className="meta"><span>{m.fromName} → {m.toName}</span><time>{wib(m.createdAt)}</time></div><strong>{m.subject}</strong>{m.body.slice(0, 220)}</li>
        ))}
        {!snap.messages.length && <li>Belum ada pesan.</li>}
      </ul>
    </div>
  );
}
