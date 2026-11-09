import "server-only";
import path from "node:path";
import { z } from "zod";
import { ROSTER, resolveWho } from "../roster";
import type {
  ApprovalView,
  DebateView,
  EquityView,
  ExecutionView,
  JournalView,
  StrategyJournal,
  TradeView,
  OpsView,
  RegimeView,
  CrowdView,
  ScalpView,
  ScalpHistoryItem,
  CalendarView,
  LabView,
  ReviewView,
  LogLineView,
  MessageView,
  PositionView,
  RiskRuleView,
  ScanRowView,
  ScanView,
  WatchItem,
} from "../types";
import { exists, listDir, officePath, readHead, readJson, readText, statSafe } from "./fsx";
import {
  AgentStatusSchema,
  ApprovalSchema,
  BotStateSchema,
  DebateFileSchema,
  EquityLineSchema,
  TradeLineSchema,
  InboxMessageSchema,
  LogLineSchema,
  MarketSnapshotSchema,
  WatchlistSchema,
} from "./schemas";

/* ------------------------------------------------------------------ agents/<slug>/status.json */

export function readAgentStatus(slug: string) {
  return readJson(officePath("agents", slug, "status.json"), AgentStatusSchema);
}

export function readAgentNotes(slug: string, nama: string) {
  const file = officePath("agents", slug, `CATATAN-${nama.toUpperCase()}.md`);
  const res = readText(file, 200 * 1024);
  return res ? { ...res, file: path.relative(officePath(), file) } : null;
}

/* ------------------------------------------------------------------ inbox/<who>/*.json */

export function readMessages(limitPerInbox = 30, total = 40): MessageView[] {
  const out: MessageView[] = [];
  for (const dir of listDir(officePath("inbox"))) {
    if (dir.includes("..")) continue;
    const files = listDir(officePath("inbox", dir), f => f.endsWith(".json")).sort().reverse().slice(0, limitPerInbox);
    for (const f of files) {
      const m = readJson(officePath("inbox", dir, f), InboxMessageSchema);
      if (!m) continue;
      out.push({
        key: `${dir}/${f}`,
        from: m.from,
        to: m.to,
        fromName: resolveWho(m.from).nama,
        toName: resolveWho(m.to).nama,
        subject: m.subject,
        body: m.body.slice(0, 1200),
        createdAt: m.createdAt,
        read: m.read,
      });
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, total);
}

/* ------------------------------------------------------------------ approvals/*.json */

export function readApprovals(limit = 30): ApprovalView[] {
  const dir = officePath("approvals");
  return listDir(dir, f => f.endsWith(".json"))
    .map(f => readJson(path.join(dir, f), ApprovalSchema))
    .filter((a): a is z.infer<typeof ApprovalSchema> => a !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit)
    .map(a => ({
      id: a.id,
      createdAt: a.createdAt,
      symbol: a.symbol,
      tf: a.tf,
      strategyId: a.strategyId,
      side: a.side,
      qty: a.qty ?? null,
      stop: a.stop ?? null,
      target: a.target ?? null,
      leverage: a.leverage ?? null,
      riskUsd: a.riskUsd ?? null,
      reason: a.reason,
      status: a.status,
      catatanBos: a.catatanBos ?? "",
      decidedAt: a.decidedAt ?? null,
    }));
}

/* ------------------------------------------------------------------ execution/ */

function readLogFile(file: string): LogLineView[] {
  const res = readText(file, 256 * 1024);
  if (!res) return [];
  const out: LogLineView[] = [];
  for (const line of res.text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = LogLineSchema.safeParse(JSON.parse(line));
      if (parsed.success) out.push(parsed.data);
    } catch {
      /* baris rusak dilewati */
    }
  }
  return out;
}

export function readExecution(): ExecutionView & { dayStartEquity: number | null } {
  const dir = officePath("execution");
  const logFiles = listDir(dir, f => /^log-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  const recent = logFiles.slice(-3).flatMap(f => readLogFile(path.join(dir, f)));

  let mode: ExecutionView["mode"] = "TIDAK DIKETAHUI";
  let modeSince: string | null = null;
  let autoEntry = false;
  for (const l of recent) {
    const m = /Bot dimulai\. Mode: (\w+)/.exec(l.msg);
    if (m) {
      mode = m[1] === "LIVE" ? "LIVE" : m[1] === "DRY_RUN" ? "DRY_RUN" : "TIDAK DIKETAHUI";
      modeSince = l.t;
      autoEntry = false;
    }
    if (l.msg.includes("REQUIRE_APPROVAL=false")) autoEntry = true;
  }

  const todayFile = logFiles.at(-1);
  const today = new Date().toISOString().slice(0, 10);
  const todayLines = todayFile === `log-${today}.jsonl` ? readLogFile(path.join(dir, todayFile)) : [];
  const rejectedToday = todayLines.filter(l => /ditolak/i.test(l.msg)).length;

  const stopFile = officePath("execution", "STOP");
  const stopStat = statSafe(stopFile);

  const state = readJson(path.join(dir, "state.json"), BotStateSchema) ?? {};
  const positions: PositionView[] = [];
  let dayStartEquity: number | null = null;
  let bestDay = -1;
  for (const [key, s] of Object.entries(state)) {
    if (s.dayStartEquity !== undefined && (s.dayKey ?? 0) >= bestDay) {
      bestDay = s.dayKey ?? 0;
      dayStartEquity = Math.max(dayStartEquity ?? 0, s.dayStartEquity);
    }
    const p = s.position;
    if (!p) continue;
    const [symbol = key, tf = "", ...rest] = key.split("_");
    positions.push({
      key,
      symbol,
      tf,
      strategyId: rest.join("_"),
      side: p.side,
      entry: p.entry,
      qty: p.qty,
      stop: p.stop,
      target: p.target ?? null,
      leverage: p.leverage,
      riskUsd: p.riskUsd,
      notional: p.entry * p.qty,
      entryTime: p.entryTime,
    });
  }

  const watchlist: WatchItem[] = (readJson(path.join(dir, "watchlist.json"), WatchlistSchema) ?? []).map(w => ({ symbol: w.symbol, tf: w.tf, strategyId: w.strategyId, ...(w.riskPct ? { riskPct: w.riskPct } : {}) }));
  const syms1h = watchlist.filter(w => w.tf === "1h").map(w => w.symbol);
  const log1h = syms1h.length ? recent.filter(l => syms1h.some(s => l.msg.startsWith(`${s} 1h`) || l.msg.startsWith(`${s}_1h`))).slice(-8).reverse() : [];
  const watchlistDraft: WatchItem[] = (readJson(path.join(dir, "watchlist.draft.json"), WatchlistSchema) ?? []).map(w => ({ symbol: w.symbol, tf: w.tf, strategyId: w.strategyId }));

  return {
    mode,
    modeSince,
    autoEntry,
    killSwitch: stopStat !== null,
    killSwitchAt: stopStat ? stopStat.mtime.toISOString() : null,
    positions,
    exposurePct: null, // dihitung di snapshot setelah equity diketahui
    rejectedToday,
    lastLog: recent.slice(-8).reverse(),
    log1h,
    watchlist,
    watchlistDraft,
    lastTickAt: recent.at(-1)?.t ?? null,
    dayStartEquity,
  };
}

export function readMarketSnapshot() {
  const s = readJson(officePath("market", "snapshot.json"), MarketSnapshotSchema);
  return {
    updatedAt: s?.updatedAt ?? null,
    rows: (s?.rows ?? []).slice(0, 30).map(r => ({ symbol: r.symbol, markPrice: r.markPrice ?? null, fundingRatePct: r.fundingRatePct ?? null })),
  };
}

/* ------------------------------------------------------------------ backtests/scan-*.md */

// scan-*.json bisa 40MB+, jadi tabel peringkat diambil dari file .md pasangannya (ratusan KB),
// dan hasil parse di-cache per mtime.
let scanCache: { file: string; mtimeMs: number; view: ScanView; all: ScanRowView[] } | null = null;

function stampToIso(stamp: string): string | null {
  const m = /(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(stamp);
  return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.000Z` : null;
}

const pct = (s: string): number | null => {
  const n = Number(s.replace(/[%+\s]/g, "").replace(/,/g, ""));
  return Number.isFinite(n) && s.trim() !== "-" ? n : null;
};

/** Scan terbaru yang memakai data asli; kalau semua sintetis, ambil yang terbaru saja. */
function pickScanFile(dir: string): string | undefined {
  const files = listDir(dir, f => /^scan-.*\.md$/.test(f)).sort().reverse();
  for (const f of files.slice(0, 8)) {
    const head = readHead(path.join(dir, f));
    if (head && !/DATA SINTETIS/i.test(head)) return f;
  }
  return files[0];
}

export function readLatestScan(): ScanView | null {
  const dir = officePath("backtests");
  const latest = pickScanFile(dir);
  if (!latest) return null;
  const file = path.join(dir, latest);
  const st = statSafe(file);
  if (!st) return null;
  if (scanCache && scanCache.file === file && scanCache.mtimeMs === st.mtimeMs) return scanCache.view;

  const res = readText(file, 1024 * 1024);
  if (!res) return null;
  const lines = res.text.split(/\r?\n/);
  const title = (lines.find(l => l.startsWith("# ")) ?? latest).replace(/^#\s*/, "");
  const synthetic = /DATA SINTETIS/i.test(res.text.slice(0, 2000));

  const start = lines.findIndex(l => /^##\s+Peringkat/i.test(l));
  const rows: ScanRowView[] = [];
  if (start >= 0) {
    for (let i = start + 1; i < lines.length; i++) {
      const l = lines[i]!.trim();
      if (!l.startsWith("|")) {
        if (rows.length) break;
        continue;
      }
      const cells = l.split("|").slice(1, -1).map(c => c.trim());
      if (!/^\d+$/.test(cells[0] ?? "")) continue; // header & separator
      rows.push({
        rank: Number(cells[0]),
        symbol: cells[1] ?? "",
        tf: cells[2] ?? "",
        strategy: cells[3] ?? "",
        trades: Number.isFinite(Number(cells[4])) ? Number(cells[4]) : null,
        winPct: cells[5] ?? "",
        pf: cells[6] ?? "",
        returnPct: pct(cells[8] ?? ""),
        expR: Number.isFinite(Number(cells[7])) && (cells[7] ?? "").trim() !== "" ? Number(cells[7]) : null,
        maxDd: cells[9] ?? "",
        holdPct: pct(cells[10] ?? ""),
        vonis: cells[cells.length - 1] ?? "",
      });
    }
  }

  const view: ScanView = {
    file: latest,
    createdAt: stampToIso(latest),
    title,
    synthetic,
    total: rows.length,
    kandidat: rows.filter(r => /^kandidat/i.test(r.vonis)).length,
    top: rows.slice(0, 20),
  };
  scanCache = { file, mtimeMs: st.mtimeMs, view, all: rows };
  return view;
}

/** Isi laporan .md untuk tombol "buka laporan" di Ruang Jurnal. Nama file divalidasi ketat. */
export function readScanReport(name: string): string | null {
  if (!/^scan-[\w-]+\.md$/.test(name)) return null;
  return readText(officePath("backtests", name), 400 * 1024)?.text ?? null;
}

/* ------------------------------------------------------------------ debates/debate-*.json */

export function readLatestDebate(): DebateView | null {
  const dir = officePath("debates");
  const latest = listDir(dir, f => /^debate-.*\.json$/.test(f)).sort().at(-1);
  if (!latest) return null;
  const d = readJson(path.join(dir, latest), DebateFileSchema);
  if (!d) return null;
  const count = (v: string) => d.results.filter(r => r.verdict === v).length;
  const order = { go_paper: 0, watch: 1, reject: 2 } as const;
  return {
    file: latest,
    createdAt: d.createdAt,
    goPaper: count("go_paper"),
    watch: count("watch"),
    reject: count("reject"),
    top: [...d.results]
      .sort((a, b) => order[a.verdict] - order[b.verdict])
      .slice(0, 6)
      .map(r => ({ symbol: r.symbol, tf: r.tf, strategyId: r.strategyId, verdict: r.verdict, confidence: r.confidence })),
  };
}

/* ------------------------------------------------------------------ execution/equity.jsonl (ditulis bot.ts) */

const wibDay = (iso: string) => new Date(Date.parse(iso) + 7 * 3_600_000).toISOString().slice(0, 10);

export function readEquity(): EquityView | null {
  const res = readText(officePath("execution", "equity.jsonl"), 1024 * 1024);
  if (!res) return null;
  const all: { t: string; equity: number; mode: string }[] = [];
  for (const line of res.text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = EquityLineSchema.safeParse(JSON.parse(line));
      if (r.success && Number.isFinite(Date.parse(r.data.t))) all.push({ ...r.data, mode: r.data.mode ?? "?" });
    } catch { /* baris rusak dilewati */ }
  }
  if (!all.length) return null;
  all.sort((a, b) => a.t.localeCompare(b.t));
  // Hanya mode terakhir (DRY_RUN memakai equity dummy, jangan dicampur dengan LIVE).
  const mode = all.at(-1)!.mode;
  // Deposit/penarikan (execution/transfers.jsonl, dicatat bot): tiap titik ditambah transfer SESUDAH titik itu, jadi kurva
  // tidak melonjak saat deposit dan perubahan harian = untung/rugi trading saja. Titik terakhir tetap saldo asli.
  const transfers: { ms: number; amount: number }[] = [];
  for (const line of readText(officePath("execution", "transfers.jsonl"), 256 * 1024)?.text.split("\n") ?? []) {
    try { const j = JSON.parse(line) as { t?: unknown; amount?: unknown }; const ms = Date.parse(String(j.t)); const a = Number(j.amount); if (Number.isFinite(ms) && Number.isFinite(a)) transfers.push({ ms, amount: a }); } catch { /* baris kosong */ }
  }
  const pts = all.filter(p => p.mode === mode).map(p => {
    const ms = Date.parse(p.t);
    const later = transfers.reduce((s, x) => (x.ms > ms ? s + x.amount : s), 0);
    return later ? { ...p, equity: p.equity + later } : p;
  });
  const firstMs = Date.parse(pts[0]!.t);
  const netTransfers = transfers.filter(x => x.ms > firstMs).reduce((s, x) => s + x.amount, 0);
  const last = pts.at(-1)!;
  const today = wibDay(last.t);
  const before = pts.filter(p => wibDay(p.t) < today).at(-1);
  const dayStart = before?.equity ?? pts.find(p => wibDay(p.t) === today)?.equity ?? null;
  const dayChange = dayStart != null ? last.equity - dayStart : null;
  // Reset batas rugi harian (execution/DAY_RESET, ditulis `npm run bot:reset-day`): sama seperti bot, hanya hari yang sama.
  let dayReset: EquityView["dayReset"] = null;
  const resetIso = readText(officePath("execution", "DAY_RESET"), 256)?.text.trim() ?? "";
  const resetMs = Date.parse(resetIso);
  // Reset yang lebih baru dari titik equity terakhir tetap berlaku: basisnya titik terakhir itu (perubahan 0).
  if (Number.isFinite(resetMs) && wibDay(new Date(resetMs).toISOString()) === today && resetMs <= Date.now()) {
    const base = pts.filter(p => Date.parse(p.t) <= resetMs).at(-1) ?? pts.find(p => Date.parse(p.t) > resetMs);
    if (base) dayReset = { at: new Date(resetMs).toISOString(), start: base.equity, change: last.equity - base.equity, changePct: ((last.equity - base.equity) / base.equity) * 100 };
  }

  // Perubahan per hari: close hari ini dikurangi close hari sebelumnya.
  const closes = new Map<string, number>();
  const opens = new Map<string, number>();
  for (const p of pts) { if (!opens.has(wibDay(p.t))) opens.set(wibDay(p.t), p.equity); closes.set(wibDay(p.t), p.equity); }
  const days = [...closes.keys()].sort();
  const daily = days.map((d, i) => ({ day: d, pnl: closes.get(d)! - (i > 0 ? closes.get(days[i - 1]!)! : opens.get(d)!) })).slice(-14);

  const since = Date.parse(last.t) - 7 * 86_400_000;
  const recent = pts.filter(p => Date.parse(p.t) >= since);
  const step = Math.max(1, Math.ceil(recent.length / 240));
  const points = recent.filter((_, i) => i % step === 0 || i === recent.length - 1).map(p => ({ t: p.t, equity: p.equity }));

  return {
    mode: mode.toUpperCase(),
    last: last.equity,
    lastAt: last.t,
    dayStart,
    dayChange,
    dayChangePct: dayStart ? (dayChange! / dayStart) * 100 : null,
    points,
    daily,
    count: pts.length,
    netTransfers,
    dayReset,
  };
}

/* ------------------------------------------------------------------ execution/trades.jsonl (jurnal dari bot.ts) */

// Nama strategi sama dengan trading-floor-engine/src/strategies/index.ts (laporan scan .md memakai nama, bukan id).
export const STRATEGY_NAMES: Record<string, string> = {
  ema_trend: "EMA cross + filter EMA200 (baseline)",
  donchian: "Donchian breakout + ATR trailing",
  ema_adx: "EMA cross + filter ADX",
  rsi_range: "RSI mean reversion di pasar range",
  trend_long: "Long-only tren + ATR trailing",
};

function backtestFor(symbol: string, tf: string, strategyId: string): StrategyJournal["bt"] {
  readLatestScan();
  const name = STRATEGY_NAMES[strategyId] ?? strategyId;
  const row = scanCache?.all.find(r => r.symbol === symbol && r.tf === tf && r.strategy === name);
  if (!row || !scanCache) return null;
  return { winPct: pct(row.winPct), expR: row.expR, trades: row.trades, vonis: row.vonis, file: scanCache.view.file };
}

export function readJournal(): JournalView | null {
  const res = readText(officePath("execution", "trades.jsonl"), 1024 * 1024);
  if (!res) return null;
  const all: TradeView[] = [];
  res.text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const r = TradeLineSchema.safeParse(JSON.parse(line));
      if (!r.success) return;
      const d = r.data;
      all.push({
        key: `${d.t}-${i}`, t: d.t, mode: d.mode.toUpperCase(), symbol: d.symbol, tf: d.tf, strategyId: d.strategyId, side: d.side,
        entry: d.entry, exit: d.exit, pnl: d.pnl, r: d.r, fees: d.fees, funding: d.funding, reason: d.reason, source: d.source, crowd: d.crowd ?? null,
        holdHours: d.openedAt && d.closedAt ? (d.closedAt - d.openedAt) / 3_600_000 : null,
      });
    } catch { /* baris rusak dilewati */ }
  });
  if (!all.length) return null;
  all.sort((a, b) => a.t.localeCompare(b.t));
  const mode = all.at(-1)!.mode;
  const trades = all.filter(t => t.mode === mode);
  const stats = (ts: TradeView[]) => {
    const wins = ts.filter(t => t.pnl > 0).length;
    return { n: ts.length, wins, winRate: ts.length ? (wins / ts.length) * 100 : 0, avgR: ts.reduce((s, t) => s + t.r, 0) / Math.max(1, ts.length), pnl: ts.reduce((s, t) => s + t.pnl, 0) };
  };
  const groups = new Map<string, TradeView[]>();
  for (const t of trades) {
    const k = `${t.symbol}|${t.tf}|${t.strategyId}`;
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  const byStrategy: StrategyJournal[] = [...groups.entries()].map(([k, ts]) => {
    const [symbol, tf, strategyId] = k.split("|") as [string, string, string];
    const s = stats(ts);
    const bt = backtestFor(symbol, tf, strategyId);
    let status: StrategyJournal["status"] = "tanpa data backtest";
    if (s.n < 10) status = "sampel kecil";
    else if (bt?.expR != null) {
      const winGap = bt.winPct != null ? s.winRate - bt.winPct : 0;
      if (s.avgR < bt.expR - 0.4 || winGap < -15) status = "di bawah backtest";
      else if (s.avgR > bt.expR + 0.4 && winGap > -5) status = "di atas backtest";
      else status = "sesuai backtest";
    }
    return { symbol, tf, strategyId, n: s.n, winRate: s.winRate, avgR: s.avgR, pnl: s.pnl, bt, status };
  }).sort((a, b) => b.n - a.n);
  const tot = stats(trades);
  return {
    mode, total: tot.n, wins: tot.wins, winRate: tot.winRate, avgR: tot.avgR, totalPnl: tot.pnl,
    lastAt: trades.at(-1)!.t, recent: trades.slice(-15).reverse(), byStrategy,
  };
}

/* ------------------------------------------------------------------ RISK-RULES.md */

export function readRiskRules(): RiskRuleView[] {
  const res = readText(officePath("RISK-RULES.md"), 64 * 1024);
  if (!res) return [];
  const lines = res.text.split(/\r?\n/);
  const start = lines.findIndex(l => /^\|\s*Aturan\s*\|\s*Nilai\s*\|/i.test(l.trim()));
  if (start < 0) return [];
  const out: RiskRuleView[] = [];
  for (let i = start + 2; i < lines.length; i++) {
    const l = lines[i]!.trim();
    if (!l.startsWith("|")) break;
    const [aturan = "", nilai = ""] = l.split("|").slice(1, -1).map(c => c.trim().replace(/\*\*/g, ""));
    out.push({ aturan, nilai });
  }
  return out;
}

export function officeState() {
  const ok = exists(officePath());
  const empty = ok && ["agents", "inbox", "execution", "backtests"].every(d => listDir(officePath(d)).length === 0);
  return { ok, empty };
}

export function agentSlugs() {
  return ROSTER.map(r => r.slug);
}

/* ------------------------------------------------------------------ layanan kantor (ditulis notifier / npm run ...) */

const ageMin = (ms: number | null) => (ms == null ? null : (Date.now() - ms) / 60_000);
const mtime = (p: string) => statSafe(p)?.mtimeMs ?? null;
const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());

const RegimeFileSchema = z.looseObject({
  updatedAt: z.string(),
  rows: z.array(z.looseObject({ symbol: z.string(), regime: z.string(), label: z.string(), close: z.number(), adx: z.number(), atrPct: z.number(), atrPctile: z.number(), chg24h: z.number() })),
  fits: z.array(z.looseObject({ symbol: z.string(), tf: z.string(), strategyId: z.string(), regime: z.string(), fit: z.enum(["cocok", "kurang cocok", "netral"]), note: z.string() })).default([]),
});
export function readRegime(): RegimeView | null {
  const r = readJson(officePath("market", "regime.json"), RegimeFileSchema);
  return r ? { updatedAt: r.updatedAt, rows: r.rows, fits: r.fits } : null;
}

const MeetingFileSchema = z.looseObject({
  kind: z.string().default("briefing"),
  title: z.string(),
  agenda: z.string().default(""),
  attendees: z.array(z.string()).default([]),
  at: z.string(),
  until: z.string(),
});
/** Meeting dari notifier (briefing Head Trader / rapat darurat). Null kalau tidak ada atau sudah lewat. */
export function readMeeting(now = Date.now()): { kind: string; title: string; agenda: string; attendees: string[]; at: string } | null {
  const m = readJson(officePath("meetings", "current.json"), MeetingFileSchema);
  if (!m) return null;
  const from = Date.parse(m.at), until = Date.parse(m.until);
  if (!Number.isFinite(from) || !Number.isFinite(until) || now < from || now >= until) return null;
  return { kind: m.kind, title: m.title, agenda: m.agenda, attendees: m.attendees, at: m.at };
}

const num = z.number().finite().nullable().default(null);
const CrowdFileSchema = z.looseObject({
  updatedAt: z.string(),
  fearGreed: z.looseObject({ value: z.number().finite(), label: z.string(), prev: num }).nullable().default(null),
  rows: z.array(z.looseObject({
    symbol: z.string(), funding: num, oiChg24h: num, lsRatio: num, takerRatio: num,
    flag: z.enum(["long ramai", "short ramai", "normal"]).catch("normal"), note: z.string().default(""),
  })).default([]),
});
export function readCrowd(): CrowdView | null {
  const c = readJson(officePath("market", "crowd.json"), CrowdFileSchema);
  if (!c) return null;
  return {
    updatedAt: c.updatedAt,
    fearGreed: c.fearGreed ? { value: c.fearGreed.value, label: c.fearGreed.label, prev: c.fearGreed.prev } : null,
    rows: c.rows.map(r => ({ symbol: r.symbol, funding: r.funding, oiChg24h: r.oiChg24h, lsRatio: r.lsRatio, takerRatio: r.takerRatio, flag: r.flag, note: r.note })),
  };
}

const CalendarFileSchema = z.looseObject({
  updatedAt: z.string(),
  source: z.string().default("ForexFactory"),
  events: z.array(z.looseObject({ title: z.string(), country: z.string(), impact: z.string(), at: z.string(), forecast: z.string().default(""), previous: z.string().default("") })),
});
export function readCalendar(): CalendarView | null {
  const c = readJson(officePath("market", "calendar.json"), CalendarFileSchema);
  if (!c) return null;
  const now = Date.now();
  const events = c.events
    .filter(e => Date.parse(e.at) > now - 12 * 3_600_000 && Date.parse(e.at) < now + 8 * 86_400_000)
    .map(e => ({ title: e.title, country: e.country, impact: e.impact, at: e.at, forecast: e.forecast, previous: e.previous }));
  const high = events.filter(e => e.impact === "High");
  return {
    updatedAt: c.updatedAt, source: c.source, events: events.slice(0, 40),
    nextHigh: high.find(e => Date.parse(e.at) > now) ?? null,
    nearHigh: high.find(e => Math.abs(Date.parse(e.at) - now) <= 30 * 60_000) ?? null,
  };
}

const LabFileSchema = z.looseObject({
  createdAt: z.string(), from: z.string().default(""), recentDays: z.number().default(180),
  rows: z.array(z.looseObject({
    symbol: z.string(), tf: z.string(), strategyId: z.string(), strategyName: z.string().default(""),
    full: z.looseObject({ trades: z.number(), winRate: z.number(), avgR: z.number(), returnPct: z.number(), maxDD: z.number(), pf: z.number() }),
    recent: z.looseObject({ days: z.number(), trades: z.number(), winRate: z.number(), avgR: z.number() }),
    verdict: z.string().default("-"), status: z.string(), note: z.string().default(""),
  })),
});
export function readLab(): LabView | null {
  const dir = officePath("lab");
  const latest = listDir(dir, f => /^lab-.*\.json$/.test(f)).sort().at(-1);
  if (!latest) return null;
  const l = readJson(path.join(dir, latest), LabFileSchema);
  return l ? { file: latest, createdAt: l.createdAt, from: l.from, recentDays: l.recentDays, rows: l.rows } : null;
}

const n0 = z.number().catch(0);
const ScalpGroup = z.looseObject({ key: z.string(), n: n0, positive: n0, kandidat: n0, avgR: n0, grossR: n0, winRate: n0, perDay: n0 });
const ScalpFileSchema = z.looseObject({
  createdAt: z.string(),
  symbols: z.array(z.string()).default([]),
  tfs: z.array(z.string()).default([]),
  leverageForRoe: z.number().default(20),
  rows: z.array(z.looseObject({
    symbol: z.string(), tf: z.string(), strategyId: z.string(), strategyName: z.string().default(""),
    targetPct: n0, stopPct: n0, roeTarget: n0, roeStop: n0, trades: n0, perDay: n0, winRate: n0, avgR: n0, grossR: n0, feeR: n0,
    pf: z.number().nullable().catch(null).transform(v => v ?? Infinity), returnPct: n0, maxDD: n0, level: z.string(), label: z.string(),
  })).default([]),
  byTarget: z.array(ScalpGroup).default([]),
  byStrategy: z.array(ScalpGroup).default([]),
  byTf: z.array(ScalpGroup).default([]),
});
/** Hasil riset scalping terbaru (office/scalp/scalp-*.json). Riset saja, tidak dipakai bot. */
export function readScalp(): ScalpView | null {
  const dir = officePath("scalp");
  const latest = listDir(dir, f => /^scalp-.*\.json$/.test(f)).sort().at(-1);
  if (!latest) return null;
  const s = readJson(path.join(dir, latest), ScalpFileSchema);
  if (!s) return null;
  return {
    file: latest.replace(/\.json$/, ".md"), createdAt: s.createdAt, symbols: s.symbols, tfs: s.tfs, leverageForRoe: s.leverageForRoe,
    total: s.rows.length, kandidat: s.rows.filter(r => r.level === "kandidat_paper").length, positive: s.rows.filter(r => r.avgR > 0).length,
    top: s.rows.slice(0, 12), byTarget: s.byTarget, byStrategy: s.byStrategy, byTf: s.byTf,
  };
}

const MtfFileSchema = z.looseObject({
  createdAt: z.string(),
  baseTotal: z.number(),
  rows: z.array(z.looseObject({ key: z.string() })).default([]),
  variantTotals: z.array(z.looseObject({ pullback: z.number(), windowH: z.number(), totalR: z.number() })).default([]),
});
/** Semua uji riset di office/scalp, terbaru dulu (maks 10). */
export function readScalpHistory(): ScalpHistoryItem[] {
  const dir = officePath("scalp");
  const out: ScalpHistoryItem[] = [];
  const sign = (x: number, d = 2) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}`;
  for (const f of listDir(dir, n => /^(scalp|mtf)-.*\.json$/.test(n)).sort().reverse().slice(0, 10)) {
    if (f.startsWith("scalp-")) {
      const s = readJson(path.join(dir, f), ScalpFileSchema);
      if (!s) continue;
      const kand = s.rows.filter(r => r.level === "kandidat_paper").length;
      const best = s.rows[0];
      const sesi = s.rows.some(r => r.strategyId.endsWith("_sesi"));
      out.push({
        createdAt: s.createdAt, kind: "scalp",
        label: `Scalping ${s.symbols.length === 1 ? s.symbols[0]!.replace("USDT", "") : `${s.symbols.length} koin`} · ${s.tfs.join("/")}${sesi ? " · + filter jam ramai" : ""} · ${s.rows.length} uji`,
        result: kand ? `${kand} kandidat` : best ? `0 kandidat · terbaik ${best.symbol.replace("USDT", "")} ${best.tf} ${best.strategyId.replace("scalp_", "")} ${best.targetPct}%: ${sign(best.avgR)}R` : "tidak ada hasil",
        good: kand > 0,
      });
    } else {
      const m = readJson(path.join(dir, f), MtfFileSchema);
      if (!m) continue;
      const bestV = [...m.variantTotals].sort((a, b) => b.totalR - a.totalR)[0];
      out.push({
        createdAt: m.createdAt, kind: "mtf",
        label: `Sinyal 4h + entry 15m · ${m.rows.length} koin`,
        result: `4h biasa ${sign(m.baseTotal, 1)}R vs entry 15m terbaik ${bestV ? sign(bestV.totalR, 1) : "-"}R`,
        good: bestV ? bestV.totalR > m.baseTotal : false,
      });
    }
  }
  out.push(...scan1hHistory());
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 12);
}

/** Scan timeframe 1h (office/backtests/scan-*.md). Dibaca dari laporan .md yang kecil, bukan .json (puluhan MB), dan
 * di-cache per nama file karena laporan scan tidak pernah diubah setelah ditulis. */
const scan1hCache = new Map<string, { tf: string; n: number; coins: number; best: { sym: string; r: number } | null; kand: { sym: string; strat: string; r: number }[] } | null>();
function scan1hHistory(): ScalpHistoryItem[] {
  const dir = officePath("backtests");
  const inWatch = new Set((readJson(officePath("execution", "watchlist.json"), WatchlistSchema) ?? []).filter(w => w.tf === "1h").map(w => w.symbol));
  const out: ScalpHistoryItem[] = [];
  for (const f of listDir(dir, n => /^scan-.*\.md$/.test(n)).sort().slice(-15)) {
    if (!scan1hCache.has(f)) {
      const text = readText(path.join(dir, f), 512 * 1024)?.text ?? "";
      const rows = text.split("\n").filter(l => /^\|\s*\d+\s*\|/.test(l)).map(l => l.split("|").map(c => c.trim()))
        .filter(c => c[3] === "1h" || c[3] === "15m");
      scan1hCache.set(f, rows.length ? {
        tf: rows[0]![3]!, n: rows.length, coins: new Set(rows.map(c => c[2])).size,
        best: rows[0] ? { sym: rows[0][2]!.replace("USDT", ""), r: Number(rows[0][8]) } : null,
        kand: rows.filter(c => /^Kandidat/i.test(c.at(-2) ?? "")).map(c => ({ sym: c[2]!.replace("USDT", ""), strat: c[4]!, r: Number(c[8]) })),
      } : null);
    }
    const s = scan1hCache.get(f);
    if (!s) continue;
    const m = /^scan-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(f);
    const used = s.kand.filter(k => inWatch.has(`${k.sym}USDT`)).map(k => k.sym);
    out.push({
      createdAt: m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.000Z` : new Date(0).toISOString(), kind: "scan1h",
      label: `Scan ${s.tf} · ${s.coins} koin · ${s.n} uji`,
      result: s.kand.length
        ? `${s.kand.length} kandidat: ${s.kand.map(k => `${k.sym} ${k.r >= 0 ? "+" : ""}${k.r.toFixed(2)}R`).join(", ")}${used.length ? ` · dipakai bot: ${used.join(", ")}` : ""}`
        : `0 kandidat${s.best ? ` · terbaik ${s.best.sym} ${s.best.r >= 0 ? "+" : ""}${s.best.r.toFixed(2)}R` : ""}`,
      good: s.kand.length > 0,
    });
  }
  return out;
}

const Stat = z.looseObject({ n: z.number(), winRate: z.number(), avgR: z.number(), pnl: z.number() });
const ReviewFileSchema = z.looseObject({
  week: z.string(), mode: z.string().default("LIVE"), createdAt: z.string(),
  trades: Stat, prev: Stat,
  equity: z.looseObject({ change: z.number().nullable(), changePct: z.number().nullable(), worstDay: z.looseObject({ day: z.string(), pnl: z.number() }).nullable() }),
  entries: z.number().default(0), rejected: z.number().default(0), errors: z.number().default(0),
  byStrategy: z.array(z.looseObject({ key: z.string(), n: z.number(), winRate: z.number(), avgR: z.number(), pnl: z.number() })).default([]),
  notes: z.array(z.string()).default([]),
});
export function readReview(): ReviewView | null {
  const dir = officePath("reviews");
  const latest = listDir(dir, f => /^review-.*\.json$/.test(f)).sort().at(-1);
  if (!latest) return null;
  const r = readJson(path.join(dir, latest), ReviewFileSchema);
  if (!r) return null;
  const md = latest.replace(/\.json$/, ".md");
  return {
    week: r.week, mode: r.mode, createdAt: r.createdAt,
    trades: { n: r.trades.n, winRate: r.trades.winRate, avgR: r.trades.avgR, pnl: r.trades.pnl },
    prev: { n: r.prev.n, winRate: r.prev.winRate, avgR: r.prev.avgR, pnl: r.prev.pnl },
    equity: { change: r.equity.change, changePct: r.equity.changePct, worstDay: r.equity.worstDay },
    entries: r.entries, rejected: r.rejected, errors: r.errors, byStrategy: r.byStrategy, notes: r.notes,
    markdownFile: exists(path.join(dir, md)) ? md : null,
  };
}

export function readReviewMarkdown(name: string): string | null {
  if (!/^review-[\w-]+\.md$/.test(name)) return null;
  return readText(officePath("reviews", name), 200 * 1024)?.text ?? null;
}

export function readOps(): OpsView {
  const botBeat = mtime(officePath("execution", "state.json"));
  const notBeat = mtime(officePath("execution", "notifier-state.json"));
  const stopped = exists(officePath("execution", "STOP"));
  const botAge = ageMin(botBeat), notAge = ageMin(notBeat);
  const dir = officePath("execution");
  const today = new Date().toISOString().slice(0, 10);
  const todayLog = readText(path.join(dir, `log-${today}.jsonl`), 512 * 1024)?.text ?? "";
  const lines: { t: string; msg: string }[] = [];
  for (const l of todayLog.split("\n")) { try { lines.push(JSON.parse(l)); } catch { /* lewati */ } }
  const errs = lines.filter(l => /GAGAL|ERROR|KRITIS|FATAL/.test(l.msg ?? ""));
  const latestIn = (sub: string, re: RegExp) => listDir(officePath(sub), f => re.test(f)).sort().at(-1);
  const labFile = latestIn("lab", /^lab-.*\.json$/), revFile = latestIn("reviews", /^review-.*\.json$/);
  return {
    bot: {
      status: botBeat == null ? "belum pernah jalan" : stopped ? "dihentikan" : botAge! <= 10 ? "hidup" : "tidak merespons",
      lastBeat: iso(botBeat), ageMin: botAge,
    },
    notifier: { status: notBeat == null ? "belum pernah jalan" : notAge! <= 2 ? "hidup" : "mati", lastBeat: iso(notBeat), ageMin: notAge },
    errorsToday: errs.length,
    lastErrors: errs.slice(-5).reverse(),
    lastLogAt: lines.at(-1)?.t ?? null,
    calendarAt: iso(mtime(officePath("market", "calendar.json"))),
    regimeAt: iso(mtime(officePath("market", "regime.json"))),
    labAt: labFile ? iso(mtime(officePath("lab", labFile))) : null,
    reviewAt: revFile ? iso(mtime(officePath("reviews", revFile))) : null,
  };
}
