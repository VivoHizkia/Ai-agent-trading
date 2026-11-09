import "server-only";
import { ROSTER, type AgentSlug } from "../roster";
import type { AccountView, AgentDetail, AgentView, Snapshot } from "../types";
import { OFFICE_DIR } from "./fsx";
import {
  officeState,
  readAgentNotes,
  readAgentStatus,
  readApprovals,
  readExecution,
  readLatestDebate,
  readLatestScan,
  readMarketSnapshot,
  readEquity,
  readJournal,
  readMessages,
  readOps,
  readRegime,
  readCrowd,
  readMeeting,
  readScalp,
  readScalpHistory,
  readCalendar,
  readLab,
  readReview,
  readRiskRules,
} from "./readers";

const MEETING_WINDOW_MS = 15 * 60 * 1000;
const STALE_SCAN_MS = 24 * 60 * 60 * 1000;

const fmtUsd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Ambil angka pertama dari teks nilai aturan, mis. "1% equity" → 1, "25x" → 25. */
function firstNumber(s: string | undefined, fallback: number) {
  const m = s ? /(\d+(?:[.,]\d+)?)/.exec(s) : null;
  return m ? Number(m[1]!.replace(",", ".")) : fallback;
}

export function buildSnapshot(): Snapshot {
  const now = Date.now();
  const { ok, empty } = officeState();
  const warnings: string[] = [];
  if (!ok) warnings.push(`Folder office/ tidak ditemukan di ${OFFICE_DIR}. Atur OFFICE_DIR di .env.local.`);

  const messages = ok ? readMessages() : [];
  const approvals = ok ? readApprovals() : [];
  const exec = ok ? readExecution() : null;
  const scan = ok ? readLatestScan() : null;
  const debate = ok ? readLatestDebate() : null;
  const marketSnapshot = ok ? readMarketSnapshot() : { updatedAt: null, rows: [] };
  const riskRules = ok ? readRiskRules() : [];
  const equity = ok ? readEquity() : null;
  const journal = ok ? readJournal() : null;
  const ops = readOps();
  const regime = ok ? readRegime() : null;
  const crowd = ok ? readCrowd() : null;
  const scalp = ok ? readScalp() : null;
  const scalpHistory = ok ? readScalpHistory() : [];
  const calendar = ok ? readCalendar() : null;
  const lab = ok ? readLab() : null;
  const review = ok ? readReview() : null;

  const rule = (re: RegExp) => riskRules.find(r => re.test(r.aturan))?.nilai;
  const envEquity = Number(process.env.NEXT_PUBLIC_DISPLAY_EQUITY ?? "81.01");
  const account: AccountView = {
    equity: equity?.last ?? exec?.dayStartEquity ?? (Number.isFinite(envEquity) ? envEquity : 0),
    equitySource: equity ? "equity futures terakhir (dari bot)" : exec?.dayStartEquity != null ? "equity futures awal hari (dari bot)" : "equity spot (manual)",
    riskPerTradePct: firstNumber(rule(/risk per trade/i), 1),
    dailyLossPct: firstNumber(rule(/rugi harian/i), 3),
    maxPositions: firstNumber(rule(/posisi/i), 2),
    maxLeverage: firstNumber(rule(/leverage/i), 5),
  };

  const execution = exec ?? {
    mode: "TIDAK DIKETAHUI" as const,
    modeSince: null,
    autoEntry: false,
    killSwitch: false,
    killSwitchAt: null,
    positions: [],
    exposurePct: null,
    rejectedToday: 0,
    lastLog: [],
    log1h: [],
    watchlist: [],
    watchlistDraft: [],
    lastTickAt: null,
    dayStartEquity: null,
  };
  const notional = execution.positions.reduce((s, p) => s + p.notional, 0);
  execution.exposurePct = account.equity > 0 ? (notional / account.equity) * 100 : null;

  if (execution.mode === "LIVE" && execution.autoEntry) {
    warnings.push("Bot jalan di mode LIVE dengan REQUIRE_APPROVAL=false: entry baru langsung dieksekusi tanpa izin di Ruang Bos.");
  }
  if (execution.killSwitch) warnings.push("Kill switch aktif (execution/STOP ada). Bot berhenti di tick berikutnya.");
  if (ok && ops.bot.status === "tidak merespons") warnings.push(`Bot tidak merespons: execution/state.json terakhir diperbarui ${Math.round(ops.bot.ageMin ?? 0)} menit lalu. Cek terminal npm run bot.`);
  if (scan?.synthetic) warnings.push("Scan terakhir memakai data sintetis, bukan data pasar.");

  const pending = approvals.filter(a => a.status === "pending");
  const debateFresh = debate ? now - Date.parse(debate.createdAt) < MEETING_WINDOW_MS : false;
  const meeting = ok ? readMeeting(now) : null;

  const derive = (slug: AgentSlug): Omit<AgentView, "slug" | "source"> | null => {
    switch (slug) {
      case "raka": {
        const last = messages.find(m => m.to === "head_trader" || m.to === "raka");
        if (!last) return null;
        return { state: "working", bubble: `Baca pesan ${last.fromName}: ${last.subject}`, updatedAt: last.createdAt };
      }
      case "tio": {
        if (!scan) return null;
        const t = scan.top[0];
        const fresh = scan.createdAt ? now - Date.parse(scan.createdAt) < STALE_SCAN_MS : false;
        return {
          state: fresh ? "working" : "idle",
          bubble: t ? `Scan ${scan.total} baris, teratas ${t.symbol} ${t.tf}` : `Scan ${scan.file} kosong`,
          updatedAt: scan.createdAt,
        };
      }
      case "sendi":
        if (!debate) return null;
        return { state: "working", bubble: `Debat: ${debate.goPaper} go paper, ${debate.watch} watch, ${debate.reject} reject`, updatedAt: debate.createdAt };
      case "rini": {
        const n = execution.positions.length;
        const exp = execution.exposurePct ?? 0;
        if (n) return { state: "working", bubble: `Exposure ${exp.toFixed(0)}%, ${n} posisi terbuka`, updatedAt: execution.lastTickAt };
        if (execution.rejectedToday) return { state: "working", bubble: `${execution.rejectedToday} sinyal ditolak Risk Engine hari ini`, updatedAt: execution.lastTickAt };
        return { state: "idle", bubble: "Exposure 0%, belum ada posisi", updatedAt: execution.lastTickAt };
      }
      case "eko": {
        const p = execution.positions[0];
        if (p) return { state: "working", bubble: `${p.symbol} ${p.side.toUpperCase()} jalan, SL ${p.stop} terpasang`, updatedAt: execution.lastTickAt };
        if (execution.mode === "TIDAK DIKETAHUI") return null;
        return { state: "working", bubble: `Standby ${execution.mode}, pantau ${execution.watchlist.length} pair`, updatedAt: execution.lastTickAt };
      }
      case "lala":
        if (journal) {
          return { state: "working", bubble: `Jurnal live: ${journal.total} trade, win ${journal.winRate.toFixed(0)}%, ${journal.avgR >= 0 ? "+" : ""}${journal.avgR.toFixed(2)}R rata-rata`, updatedAt: journal.lastAt };
        }
        if (!scan) return null;
        return { state: "working", bubble: `Jurnal: ${scan.kandidat} kandidat paper dari scan terakhir`, updatedAt: scan.createdAt };
    }
  };

  const agents: AgentView[] = ROSTER.map(def => {
    const status = ok ? readAgentStatus(def.slug) : null;
    const derived = derive(def.slug);
    let view: AgentView;
    if (status) {
      view = { slug: def.slug, state: status.state, bubble: status.bubble, updatedAt: status.updatedAt ?? null, source: "status.json" };
      // Kalau data turunan lebih baru dari status.json, pakai yang lebih baru.
      if (derived?.updatedAt && view.updatedAt && Date.parse(derived.updatedAt) > Date.parse(view.updatedAt) + 60_000) {
        view = { slug: def.slug, ...derived, source: "turunan" };
      }
    } else if (derived) {
      view = { slug: def.slug, ...derived, source: "turunan" };
    } else {
      view = { slug: def.slug, state: "idle", bubble: "Belum ada aktivitas", updatedAt: null, source: "default" };
    }

    // Kondisi yang selalu menang, apa pun isi status.json.
    if (def.slug === "raka" && pending.length) {
      view = { ...view, state: "waiting_approval", bubble: `${pending.length} setup nunggu izin di Ruang Bos`, source: "turunan" };
    }
    if (debateFresh && (def.slug === "raka" || def.slug === "tio" || def.slug === "sendi") && view.state !== "waiting_approval") {
      view = { ...view, state: "meeting", bubble: "Bahas hasil debat terbaru", source: "turunan" };
    }
    // Briefing Head Trader / rapat darurat dari notifier (office/meetings/current.json), 15 menit.
    if (meeting && meeting.attendees.includes(def.slug) && view.state !== "waiting_approval") {
      view = {
        ...view, state: "meeting", source: "turunan", updatedAt: meeting.at,
        bubble: def.slug === "raka" ? `${meeting.title}: ${meeting.agenda}` : `Ikut ${meeting.title.toLowerCase()}`,
      };
    }
    if (execution.killSwitch && (def.slug === "rini" || def.slug === "eko")) {
      view = { ...view, state: "alert", bubble: "Kill switch aktif. Bot berhenti", source: "turunan" };
    }
    if (view.bubble.length > 140) view.bubble = view.bubble.slice(0, 137) + "…";
    return view;
  });

  const { dayStartEquity: _ignored, ...executionView } = execution;
  void _ignored;

  return {
    generatedAt: new Date(now).toISOString(),
    officeDir: OFFICE_DIR,
    officeOk: ok,
    officeEmpty: empty,
    agents,
    messages,
    approvals,
    execution: executionView,
    scan,
    debate,
    marketSnapshot,
    riskRules,
    account,
    equity,
    journal,
    ops,
    regime,
    crowd,
    scalp,
    scalpHistory,
    calendar,
    lab,
    review,
    warnings,
  };
}

export function buildAgentDetail(slug: AgentSlug): AgentDetail {
  const def = ROSTER.find(r => r.slug === slug)!;
  const notes = readAgentNotes(def.slug, def.nama);
  const messages = readMessages(40, 200)
    .filter(m => [m.from, m.to].some(x => x === def.slug || x === def.engineId))
    .slice(0, 15);
  return { notes: notes?.text ?? "", notesFile: notes?.file ?? null, notesTruncated: notes?.truncated ?? false, messages };
}

export { fmtUsd };
