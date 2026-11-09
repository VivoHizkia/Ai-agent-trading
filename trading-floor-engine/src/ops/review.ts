// Review mingguan (Senin–Minggu WIB) dari jurnal trade, equity, dan log bot. Tanpa LLM: angka apa adanya.
// Ditulis ke office/reviews/review-<senin>.md + .json; ringkasannya juga dikirim ke Telegram oleh notifier.
import path from "node:path";
import { OFFICE_DIR } from "../report/office.js";
import { equityPoints, logLinesBetween, tradeRecords, WIB_MS, wibDay, writeJsonAtomic, type TradeRecord } from "./common.js";

export const REVIEW_DIR = path.join(OFFICE_DIR, "reviews");

/** Senin 00:00 WIB (dalam ms UTC) untuk minggu yang memuat waktu t. */
export function weekStart(t: number): number {
  const wib = new Date(t + WIB_MS);
  const dow = (wib.getUTCDay() + 6) % 7; // Senin = 0
  const midnight = Date.UTC(wib.getUTCFullYear(), wib.getUTCMonth(), wib.getUTCDate()) - WIB_MS;
  return midnight - dow * 86_400_000;
}

interface Stats { n: number; wins: number; winRate: number; avgR: number; pnl: number; best: TradeRecord | null; worst: TradeRecord | null }
function stats(ts: TradeRecord[]): Stats {
  const wins = ts.filter(t => t.pnl > 0).length;
  const sorted = [...ts].sort((a, b) => b.pnl - a.pnl);
  return {
    n: ts.length, wins, winRate: ts.length ? (wins / ts.length) * 100 : 0,
    avgR: ts.length ? ts.reduce((s, t) => s + t.r, 0) / ts.length : 0,
    pnl: ts.reduce((s, t) => s + t.pnl, 0), best: sorted[0] ?? null, worst: sorted.at(-1) ?? null,
  };
}

export interface WeeklyReview {
  week: string; from: string; to: string; mode: string;
  trades: Stats; prev: Stats;
  byStrategy: { key: string; n: number; winRate: number; avgR: number; pnl: number }[];
  equity: { start: number | null; end: number | null; change: number | null; changePct: number | null; worstDay: { day: string; pnl: number } | null };
  rejected: number; errors: number; entries: number;
  notes: string[];
  createdAt: string;
}

export function buildWeeklyReview(anyTimeInWeek: number): WeeklyReview {
  const from = weekStart(anyTimeInWeek), to = from + 7 * 86_400_000;
  const all = tradeRecords();
  const mode = all.at(-1)?.mode ?? "live";
  const inRange = (t: string, a: number, b: number) => { const x = Date.parse(t); return x >= a && x < b; };
  const week = all.filter(t => t.mode === mode && inRange(t.t, from, to));
  const prev = all.filter(t => t.mode === mode && inRange(t.t, from - 7 * 86_400_000, from));

  const groups = new Map<string, TradeRecord[]>();
  for (const t of week) { const k = `${t.symbol} ${t.tf} ${t.strategyId}`; groups.set(k, [...(groups.get(k) ?? []), t]); }
  const byStrategy = [...groups.entries()].map(([key, ts]) => { const s = stats(ts); return { key, n: s.n, winRate: s.winRate, avgR: s.avgR, pnl: s.pnl }; }).sort((a, b) => b.pnl - a.pnl);

  const pts = equityPoints().filter(p => (p.mode ?? "live") === mode);
  const before = pts.filter(p => Date.parse(p.t) < from).at(-1);
  const inWeek = pts.filter(p => inRange(p.t, from, to));
  const start = before?.equity ?? inWeek[0]?.equity ?? null;
  const end = inWeek.at(-1)?.equity ?? null;
  const closes = new Map<string, number>();
  for (const p of [...(before ? [before] : []), ...inWeek]) closes.set(wibDay(p.t), p.equity);
  const days = [...closes.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  let worstDay: { day: string; pnl: number } | null = null;
  for (let i = 1; i < days.length; i++) {
    const pnl = days[i]![1] - days[i - 1]![1];
    if (!worstDay || pnl < worstDay.pnl) worstDay = { day: days[i]![0], pnl };
  }

  const logs = logLinesBetween(from, to);
  const s = stats(week), p = stats(prev);
  const notes: string[] = [];
  if (!s.n) notes.push("Tidak ada trade yang tertutup minggu ini.");
  if (s.n && p.n) notes.push(`Rata-rata ${s.avgR >= p.avgR ? "naik" : "turun"} dari ${p.avgR.toFixed(2)}R ke ${s.avgR.toFixed(2)}R dibanding minggu lalu.`);
  for (const g of byStrategy) if (g.n >= 3 && g.avgR < 0) notes.push(`${g.key} rugi rata-rata ${g.avgR.toFixed(2)}R dari ${g.n} trade: cek di Lab R&D.`);
  const errors = logs.filter(l => /GAGAL|ERROR|KRITIS|FATAL/.test(l.msg)).length;
  if (errors) notes.push(`${errors} error tercatat di log bot minggu ini.`);

  return {
    week: wibDay(from), from: new Date(from).toISOString(), to: new Date(to).toISOString(), mode: mode.toUpperCase(),
    trades: s, prev: p, byStrategy,
    equity: { start, end, change: start != null && end != null ? end - start : null, changePct: start && end != null ? ((end - start) / start) * 100 : null, worstDay },
    rejected: logs.filter(l => /ditolak/.test(l.msg)).length,
    errors, entries: logs.filter(l => /LIVE entry|DRY RUN — akan buka/.test(l.msg)).length,
    notes, createdAt: new Date().toISOString(),
  };
}

const usd = (n: number) => `${n >= 0 ? "+" : "−"}$${Math.abs(n).toFixed(2)}`;

export function reviewMarkdown(r: WeeklyReview): string {
  const t = r.trades;
  const lines = [
    `# Review mingguan ${r.week} (${r.mode})`,
    "",
    `- Trade tertutup: **${t.n}** (minggu lalu ${r.prev.n})`,
    `- Win rate: **${t.winRate.toFixed(0)}%** · rata-rata **${t.avgR.toFixed(2)}R** · PnL **${usd(t.pnl)}**`,
    r.equity.change != null ? `- Equity: $${r.equity.start!.toFixed(2)} → $${r.equity.end!.toFixed(2)} (${usd(r.equity.change)}, ${r.equity.changePct!.toFixed(1)}%)` : "- Equity: data belum cukup",
    r.equity.worstDay ? `- Hari terburuk: ${r.equity.worstDay.day} (${usd(r.equity.worstDay.pnl)})` : "",
    `- Entry: ${r.entries} · sinyal ditolak Risk Engine: ${r.rejected} · error: ${r.errors}`,
    t.best ? `- Trade terbaik: ${t.best.symbol} ${t.best.side} ${usd(t.best.pnl)} (${t.best.r.toFixed(2)}R)` : "",
    t.worst && t.n > 1 ? `- Trade terburuk: ${t.worst.symbol} ${t.worst.side} ${usd(t.worst.pnl)} (${t.worst.r.toFixed(2)}R)` : "",
    "",
    "## Per strategi",
    r.byStrategy.length ? "| Strategi | Trade | Win | Rata-rata | PnL |\n|---|---|---|---|---|\n" + r.byStrategy.map(g => `| ${g.key} | ${g.n} | ${g.winRate.toFixed(0)}% | ${g.avgR.toFixed(2)}R | ${usd(g.pnl)} |`).join("\n") : "Belum ada.",
    "",
    "## Catatan",
    ...(r.notes.length ? r.notes.map(n => `- ${n}`) : ["- Tidak ada catatan khusus."]),
  ];
  return lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n") + "\n";
}

export function writeWeeklyReview(r: WeeklyReview) {
  writeJsonAtomic(path.join(REVIEW_DIR, `review-${r.week}.json`), r);
  writeJsonAtomic(path.join(REVIEW_DIR, `review-${r.week}.md`), reviewMarkdown(r));
}

export function reviewTelegram(r: WeeklyReview): string {
  const t = r.trades;
  return [
    `📋 <b>Review mingguan ${r.week}</b> (${r.mode})`,
    `${t.n} trade · win ${t.winRate.toFixed(0)}% · ${t.avgR >= 0 ? "+" : ""}${t.avgR.toFixed(2)}R · PnL ${usd(t.pnl)}`,
    r.equity.change != null ? `Equity ${usd(r.equity.change)} (${r.equity.changePct!.toFixed(1)}%) minggu ini` : "",
    ...r.notes.slice(0, 4).map(n => `• ${n}`),
  ].filter(Boolean).join("\n");
}
