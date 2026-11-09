"use client";

import type { Snapshot } from "@/lib/types";
import { pct, price, wib } from "./format";

const ago = (min: number | null) => (min == null ? "-" : min < 1 ? "baru saja" : min < 60 ? `${Math.round(min)} menit lalu` : min < 1440 ? `${(min / 60).toFixed(1)} jam lalu` : `${(min / 1440).toFixed(1)} hari lalu`);
const signedR = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}R`;
const signedUsd = (n: number) => `${n >= 0 ? "+" : "−"}$${Math.abs(n).toFixed(2)}`;

function countdown(iso: string) {
  const mins = Math.round((Date.parse(iso) - Date.now()) / 60_000);
  if (mins < 0) return `${-mins} menit lalu`;
  if (mins < 60) return `${mins} menit lagi`;
  if (mins < 1440) return `${Math.floor(mins / 60)} jam ${mins % 60} menit lagi`;
  return `${Math.floor(mins / 1440)} hari ${Math.floor((mins % 1440) / 60)} jam lagi`;
}

/* ------------------------------------------------------------------ Ruang Server */
export function OpsRoom({ snap }: { snap: Snapshot }) {
  const o = snap.ops;
  const cls = (st: string) => (st === "hidup" ? "ok" : st === "belum pernah jalan" ? "neutral" : "bad");
  return (
    <>
      <h2>Ruang Server</h2>
      <div className="stats">
        <div className={`stat svc ${cls(o.bot.status)}`}><span>Bot (npm run bot)</span><b>{o.bot.status}</b><em>detak terakhir {ago(o.bot.ageMin)}</em></div>
        <div className={`stat svc ${cls(o.notifier.status)}`}><span>Notifier (npm run notify)</span><b>{o.notifier.status}</b><em>detak terakhir {ago(o.notifier.ageMin)}</em></div>
      </div>
      {o.bot.status === "tidak merespons" && (
        <div className="warnbox">Bot tidak memperbarui <code>execution/state.json</code> selama {Math.round(o.bot.ageMin ?? 0)} menit. Cek PC (sleep?), internet, dan terminal <code>npm run bot</code>. SL/TP yang sudah terpasang di Binance tetap aktif.</div>
      )}
      {o.notifier.status !== "hidup" && (
        <div className="warnbox">Notifier tidak jalan: tidak ada Telegram, kalender, regime, review, maupun Lab. Jalankan <code>npm run notify</code> di folder engine.</div>
      )}
      <div className="sec">
        <h3>Error hari ini · {o.errorsToday}</h3>
        {o.lastErrors.length ? (
          <ol className="loglist">{o.lastErrors.map((l, i) => <li key={i}><time>{wib(l.t)}</time> {l.msg}</li>)}</ol>
        ) : <p className="muted-p">Tidak ada error di log bot hari ini.</p>}
      </div>
      <div className="sec">
        <h3>Kesegaran data</h3>
        <table className="tbl">
          <tbody>
            <tr><td>Log bot terakhir</td><td>{wib(o.lastLogAt)}</td></tr>
            <tr><td>Kalender berita</td><td>{wib(o.calendarAt)}</td></tr>
            <tr><td>Regime market</td><td>{wib(o.regimeAt)}</td></tr>
            <tr><td>Lab R&amp;D</td><td>{wib(o.labAt)}</td></tr>
            <tr><td>Review mingguan</td><td>{wib(o.reviewAt)}</td></tr>
          </tbody>
        </table>
        <p className="fine-inline">Bot dianggap hidup kalau <code>execution/state.json</code> diperbarui dalam 10 menit terakhir (bot menyimpannya tiap ~1 menit). Kalau bot diam lebih dari itu, notifier mengirim peringatan ke Telegram.</p>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ Ruang Regime */
const REGIME_CLASS: Record<string, string> = { tren_naik: "ok", tren_turun: "bad", sideways: "warn", volatil: "purple", transisi: "neutral" };
function fngClass(v: number) { return v <= 25 ? "bad" : v < 45 ? "warn" : v <= 55 ? "neutral" : v < 75 ? "ok" : "hot"; }

function CrowdSection({ snap }: { snap: Snapshot }) {
  const c = snap.crowd;
  if (!c) return (<div className="sec"><h3>Keramaian pasar</h3><p className="muted-p">Belum ada data. Diambil oleh <code>npm run notify</code> tiap 30 menit, atau jalankan <code>npm run crowd</code> di engine.</p></div>);
  const fg = c.fearGreed;
  return (
    <div className="sec">
      <h3>Keramaian pasar · {wib(c.updatedAt)}</h3>
      {fg && (
        <div className="fng">
          <div className="fng-bar"><span className="fng-pin" style={{ left: `${Math.max(0, Math.min(100, fg.value))}%` }} /></div>
          <div className="fng-row">
            <span className={`status-chip ${fngClass(fg.value)}`}>Fear &amp; Greed {fg.value} · {fg.label}</span>
            {fg.prev != null && <span className="fine-inline">kemarin {fg.prev}</span>}
          </div>
          <div className="fine-inline">Data Fear &amp; Greed: <a href="https://alternative.me/crypto/fear-and-greed-index/" target="_blank" rel="noreferrer">alternative.me</a></div>
        </div>
      )}
      <table className="tbl">
        <thead><tr><th>Pair</th><th>Funding</th><th>OI 24j</th><th>L/S top</th><th>Taker</th></tr></thead>
        <tbody>{c.rows.map(x => (
          <tr key={x.symbol} title={x.note || undefined}>
            <td>{x.symbol.replace("USDT", "")}{x.flag !== "normal" && <small className="sub"><span className="status-chip bad">{x.flag}</span></small>}</td>
            <td className={x.funding != null && x.funding < 0 ? "dn" : ""}>{x.funding != null ? `${(x.funding * 100).toFixed(4)}%` : "-"}</td>
            <td className={x.oiChg24h != null ? (x.oiChg24h >= 0 ? "up" : "dn") : ""}>{x.oiChg24h != null ? pct(x.oiChg24h, true) : "-"}</td>
            <td>{x.lsRatio?.toFixed(2) ?? "-"}</td>
            <td className={x.takerRatio != null ? (x.takerRatio >= 1 ? "up" : "dn") : ""}>{x.takerRatio?.toFixed(2) ?? "-"}</td>
          </tr>
        ))}</tbody>
      </table>
      <p className="fine-inline">&quot;Ramai&quot; = funding ekstrem + OI naik ≥5% sehari + top trader berat sebelah. Dicatat di log entry dan jurnal. Bot hanya menolak entry searah crowd kalau <code>CROWD_FILTER=true</code> di .env engine (default mati).</p>
    </div>
  );
}

export function RegimeRoom({ snap }: { snap: Snapshot }) {
  const r = snap.regime;
  if (!r) return (<><h2>Ruang Regime</h2><CrowdSection snap={snap} /><div className="empty"><b>Belum ada data regime.</b><p>Dihitung oleh <code>npm run notify</code> tiap 30 menit, atau jalankan <code>npm run regime</code> di engine.</p></div></>);
  return (
    <>
      <h2>Ruang Regime</h2>
      <div className="sec">
        <h3>Kondisi pasar 4h · {wib(r.updatedAt)}</h3>
        <table className="tbl">
          <thead><tr><th>Pair</th><th>Regime</th><th>ADX</th><th>ATR</th><th>24j</th></tr></thead>
          <tbody>{r.rows.map(x => (
            <tr key={x.symbol}><td>{x.symbol.replace("USDT", "")}<small className="sub">{price(x.close)}</small></td>
              <td><span className={`status-chip ${REGIME_CLASS[x.regime] ?? "neutral"}`}>{x.label}</span></td>
              <td>{x.adx.toFixed(0)}</td><td>{x.atrPct.toFixed(2)}%<small className="sub">p{x.atrPctile.toFixed(0)}</small></td>
              <td className={x.chg24h >= 0 ? "up" : "dn"}>{pct(x.chg24h, true)}</td></tr>
          ))}</tbody>
        </table>
      </div>
      <div className="sec">
        <h3>Strategi live vs regime</h3>
        <ul className="fits">
          {r.fits.map(f => (
            <li key={`${f.symbol}${f.strategyId}`}>
              <div><b>{f.symbol.replace("USDT", "")} {f.tf}</b> · {f.strategyId} <span className={`status-chip ${f.fit === "cocok" ? "ok" : f.fit === "kurang cocok" ? "bad" : "neutral"}`}>{f.fit}</span></div>
              <div className="fine-inline">{f.note}</div>
            </li>
          ))}
          {!r.fits.length && <li className="muted-p">Watchlist kosong.</li>}
        </ul>
      </div>
      <CrowdSection snap={snap} />
      <p className="fine-inline">Tren: ADX ≥ 25 dan EMA50/EMA200 searah harga. Sideways: ADX &lt; 20. Volatil: ATR di atas persentil 90 dari 200 bar terakhir. Ini hanya informasi; bot tidak otomatis berhenti karena regime.</p>
    </>
  );
}

/* ------------------------------------------------------------------ Meja Berita */
export function NewsRoom({ snap }: { snap: Snapshot }) {
  const c = snap.calendar;
  if (!c) return (<><h2>Meja Berita</h2><div className="empty"><b>Belum ada kalender berita.</b><p>Diambil oleh <code>npm run notify</code> tiap jam, atau jalankan <code>npm run calendar</code> di engine.</p></div></>);
  const byDay = new Map<string, typeof c.events>();
  for (const e of c.events) { const d = wib(e.at).replace(/\s?\d{2}:\d{2} WIB$/, "") || "Hari ini"; byDay.set(d, [...(byDay.get(d) ?? []), e]); }
  return (
    <>
      <h2>Meja Berita</h2>
      {c.nearHigh && <div className="warnbox"><b>Jendela berita:</b> {c.nearHigh.title} ({wib(c.nearHigh.at)}). Harga bisa bergerak liar; aturan tim: jangan entry 30 menit sebelum/sesudah.</div>}
      <div className="sec">
        <h3>Berita besar berikutnya</h3>
        {c.nextHigh ? (
          <div className="next-news">
            <div className="nn-cd">{countdown(c.nextHigh.at)}</div>
            <div><b>{c.nextHigh.country} · {c.nextHigh.title}</b></div>
            <div className="fine-inline">{wib(c.nextHigh.at)}{c.nextHigh.forecast ? ` · forecast ${c.nextHigh.forecast} · sebelumnya ${c.nextHigh.previous}` : ""}</div>
          </div>
        ) : <p className="muted-p">Tidak ada berita high-impact terjadwal di data saat ini.</p>}
      </div>
      <div className="sec">
        <h3>Kalender ({c.source}) · diperbarui {wib(c.updatedAt)}</h3>
        {[...byDay.entries()].map(([d, es]) => (
          <div key={d} className="news-day">
            <div className="news-date">{d}</div>
            <ul className="news-list">{es.map(e => (
              <li key={e.at + e.title} className={Date.parse(e.at) < Date.now() ? "past" : ""}>
                <time>{wib(e.at).slice(-9, -4)}</time>
                <span className={`status-chip ${e.impact === "High" ? "bad" : "warn"}`}>{e.impact === "High" ? "Tinggi" : "Sedang"}</span>
                <span>{e.country} · {e.title}</span>
              </li>
            ))}</ul>
          </div>
        ))}
      </div>
      <p className="fine-inline">Blokir entry otomatis di sekitar berita besar: isi <code>NEWS_BLACKOUT_MINUTES=30</code> di <code>.env</code> engine lalu restart bot. Default mati. Exit, SL/TP, dan posisi terbuka tidak terpengaruh.</p>
    </>
  );
}

/* ------------------------------------------------------------------ Lab R&D */
const LAB_CLASS: Record<string, string> = { stabil: "ok", membaik: "ok", melemah: "bad", "tanpa edge": "bad", "sampel kecil": "neutral", gagal: "warn" };
export function LabRoom({ snap }: { snap: Snapshot }) {
  const l = snap.lab;
  if (!l) return (<><h2>Lab R&amp;D</h2><div className="empty"><b>Belum ada uji ulang.</b><p>Lab berjalan otomatis tiap Minggu 08:00 WIB lewat <code>npm run notify</code>, atau jalankan sekarang: <code>npm run lab</code> di engine (beberapa menit).</p></div></>);
  return (
    <>
      <h2>Lab R&amp;D</h2>
      <div className="sec">
        <h3>Uji ulang strategi live · {wib(l.createdAt)}</h3>
        <ul className="fits">
          {l.rows.map(r => (
            <li key={`${r.symbol}${r.strategyId}`}>
              <div><b>{r.symbol.replace("USDT", "")} {r.tf}</b> · {r.strategyId} <span className={`status-chip ${LAB_CLASS[r.status] ?? "neutral"}`}>{r.status}</span></div>
              <div className="lab-nums">
                <span>{r.recent.days} hari terakhir: {r.recent.trades} trade · win {r.recent.winRate.toFixed(0)}% · {signedR(r.recent.avgR)}</span>
                <span>Keseluruhan OOS: {r.full.trades} trade · win {r.full.winRate.toFixed(0)}% · {signedR(r.full.avgR)} · PF {Number.isFinite(r.full.pf) ? r.full.pf.toFixed(2) : "-"} · DD {r.full.maxDD.toFixed(1)}%</span>
              </div>
              <div className="fine-inline">{r.note} Vonis: {r.verdict}.</div>
            </li>
          ))}
        </ul>
      </div>
      <p className="fine-inline">Walk-forward yang sama dengan scan (train 365 hari, test 90 hari) pada data Binance terbaru sejak {l.from}. Lab tidak mengubah watchlist; keputusan tetap di tangan Bos.</p>
    </>
  );
}

/* ------------------------------------------------------------------ Ruang Review */
export function ReviewRoom({ snap, onOpenReport }: { snap: Snapshot; onOpenReport: (n: string) => void }) {
  const r = snap.review;
  if (!r) return (<><h2>Ruang Review</h2><div className="empty"><b>Belum ada review.</b><p>Dibuat otomatis tiap Minggu 21:00 WIB lewat <code>npm run notify</code> (juga dikirim ke Telegram), atau sekarang: <code>npm run review</code> di engine.</p></div></>);
  const t = r.trades, p = r.prev;
  return (
    <>
      <h2>Ruang Review</h2>
      <div className="sec">
        <h3>Minggu {r.week} · {r.mode}</h3>
        <div className="stats four">
          <div className="stat"><span>Trade</span><b>{t.n}</b><em>lalu {p.n}</em></div>
          <div className="stat"><span>Win rate</span><b>{t.winRate.toFixed(0)}%</b><em>lalu {p.winRate.toFixed(0)}%</em></div>
          <div className="stat"><span>Rata-rata</span><b className={t.avgR >= 0 ? "up" : "dn"}>{signedR(t.avgR)}</b><em>lalu {signedR(p.avgR)}</em></div>
          <div className="stat"><span>PnL</span><b className={t.pnl >= 0 ? "up" : "dn"}>{signedUsd(t.pnl)}</b><em>lalu {signedUsd(p.pnl)}</em></div>
        </div>
        <p className="fine-inline">
          Equity {r.equity.change != null ? `${signedUsd(r.equity.change)} (${pct(r.equity.changePct, true)})` : "-"} · hari terburuk {r.equity.worstDay ? `${r.equity.worstDay.day} ${signedUsd(r.equity.worstDay.pnl)}` : "-"} · entry {r.entries} · ditolak {r.rejected} · error {r.errors}
        </p>
      </div>
      {r.byStrategy.length > 0 && (
        <div className="sec">
          <h3>Per strategi</h3>
          <table className="tbl"><thead><tr><th>Strategi</th><th>Trade</th><th>Win</th><th>R</th><th>PnL</th></tr></thead>
            <tbody>{r.byStrategy.map(g => <tr key={g.key}><td>{g.key}</td><td>{g.n}</td><td>{g.winRate.toFixed(0)}%</td><td>{signedR(g.avgR)}</td><td className={g.pnl >= 0 ? "up" : "dn"}>{signedUsd(g.pnl)}</td></tr>)}</tbody></table>
        </div>
      )}
      <div className="sec">
        <h3>Catatan</h3>
        <ul className="rules">{(r.notes.length ? r.notes : ["Tidak ada catatan khusus."]).map(n => <li key={n}>{n}</li>)}</ul>
      </div>
      {r.markdownFile && <button className="link" onClick={() => onOpenReport(r.markdownFile!)}>Buka laporan {r.markdownFile}</button>}
    </>
  );
}

/* ------------------------------------------------------------------ Ruang Scalping: meja 1h (live) + riset */
function nextHourWib() {
  const n = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 + 3_600_000 + 30_000);
  return n.toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit" });
}

export function ScalpRoom({ snap }: { snap: Snapshot }) {
  const ex = snap.execution;
  const w1h = ex.watchlist.filter(w => w.tf === "1h");
  const pos1h = ex.positions.filter(p => p.tf === "1h");
  const risk = w1h.find(w => w.riskPct)?.riskPct;
  const s = snap.scalp;
  const r2 = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}R`;
  return (
    <>
      <h2>Ruang Scalping · meja 1h</h2>
      <div className="sec">
        <h3>Strategi 1h (live)</h3>
        {w1h.length ? (
          <>
            <p className="muted-p">Slot posisi <b>{pos1h.length}/2</b> · risk {risk ? `${risk}%` : "aturan umum"} per trade · cek tiap jam, berikutnya {nextHourWib()} WIB. Terpisah dari slot 4h (2 posisi) di Execution Room.</p>
            <table className="tbl">
              <thead><tr><th>Koin</th><th>Strategi</th><th>Status</th></tr></thead>
              <tbody>{w1h.map(w => {
                const p = pos1h.find(x => x.symbol === w.symbol);
                return (
                  <tr key={`${w.symbol}${w.strategyId}`}>
                    <td>{w.symbol.replace("USDT", "")}<small className="sub">1h</small></td>
                    <td>{w.strategyId}</td>
                    <td>{p ? <><span className={p.side === "long" ? "up" : "dn"}>{p.side.toUpperCase()}</span> @ {price(p.entry)}<small className="sub">SL {price(p.stop)}{p.target != null ? ` · TP ${price(p.target)}` : ""}</small></> : <span className="fine-inline">menunggu sinyal</span>}</td>
                  </tr>
                );
              })}</tbody>
            </table>
            <h3 style={{ marginTop: 12 }}>Log 1h terakhir</h3>
            <ol className="loglist">{ex.log1h.slice(0, 6).map((l, i) => <li key={i}><time>{wib(l.t)}</time> {l.msg}</li>)}{!ex.log1h.length && <li>Belum ada kejadian khusus 1h. Ringkasan cek rutin ada di log bot.</li>}</ol>
          </>
        ) : <p className="muted-p">Belum ada strategi 1h di watchlist.</p>}
      </div>

      <div className="sec">
        <h3>Riset strategi cepat · sudah diuji</h3>
        <div className="warnbox"><b>Kesimpulan: tidak layak.</b> Semua varian scalping negatif setelah fee Binance, dan menunggu entry di 15m lebih buruk daripada entry 4h langsung. Karena itu bot memakai strategi 1h di atas, bukan scalping.</div>
        {snap.scalpHistory.length ? (
          <ul className="fits">{snap.scalpHistory.map(h => (
            <li key={h.createdAt + h.kind}>
              <div><b>{h.label}</b> <span className={`status-chip ${h.good ? "ok" : "bad"}`}>{h.kind === "mtf" ? (h.good ? "lebih baik" : "lebih buruk dari sekarang") : h.kind === "scan1h" ? (h.good ? "ada kandidat" : "tidak ada kandidat") : (h.good ? "ada kandidat" : "rugi setelah fee")}</span></div>
              <div className="fine-inline">{wib(h.createdAt)} · {h.result}</div>
            </li>
          ))}</ul>
        ) : <p className="muted-p">Belum ada riset. <code>npm run scalp:fetch</code> lalu <code>npm run scalp:test</code>.</p>}
      </div>

      {s && (
        <details className="sec">
          <summary><h3 style={{ display: "inline" }}>Detail uji scalping terakhir · {wib(s.createdAt)}</h3></summary>
          <p className="muted-p"><b>{s.kandidat}</b> kandidat dari {s.total} uji · koin {s.symbols.map(x => x.replace("USDT", "")).join(", ")} · TF {s.tfs.join(", ")}</p>
          <table className="tbl">
            <thead><tr><th>Target</th><th>Win</th><th>Setelah fee</th><th>Sebelum fee</th></tr></thead>
            <tbody>{s.byTarget.map(g => (
              <tr key={g.key}><td>{g.key} <small className="sub">ROE {(parseFloat(g.key) * s.leverageForRoe).toFixed(0)}%</small></td><td>{g.winRate.toFixed(0)}%</td>
                <td className={g.avgR >= 0 ? "up" : "dn"}>{r2(g.avgR)}</td><td className="fine-inline">{r2(g.grossR)}</td></tr>
            ))}</tbody>
          </table>
          <table className="tbl" style={{ marginTop: 8 }}>
            <thead><tr><th>Koin</th><th>Strategi</th><th>Target</th><th>Trade</th><th>Hasil</th></tr></thead>
            <tbody>{s.top.slice(0, 8).map(x => (
              <tr key={`${x.symbol}${x.tf}${x.strategyId}${x.targetPct}`}>
                <td>{x.symbol.replace("USDT", "")}<small className="sub">{x.tf}</small></td><td>{x.strategyId.replace("scalp_", "")}</td>
                <td>{x.targetPct}%</td><td>{x.trades}</td><td className={x.avgR >= 0 ? "up" : "dn"}>{r2(x.avgR)}</td>
              </tr>
            ))}</tbody>
          </table>
        </details>
      )}
    </>
  );
}
