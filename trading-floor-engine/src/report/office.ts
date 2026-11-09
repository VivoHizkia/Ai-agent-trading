// Menulis hasil ke folder ./office supaya terbaca oleh Trading Floor (Lala = Jurnal & Evaluasi).
import fs from "node:fs";
import path from "node:path";
import { REJECTION_LABEL } from "../risk/engine.js";
import type { ScanRow } from "../scan.js";
import type { DebateResult } from "../agents/debate.js";
import { agent, type AgentId } from "../agents/roster.js";

export const OFFICE_DIR = process.env.OFFICE_DIR ?? path.resolve("office");

export function writeAgentStatus(id: AgentId, bubble: string, now = new Date()) {
  const a = agent(id);
  write(path.join(OFFICE_DIR, "agents", a.name.toLowerCase(), "status.json"), JSON.stringify({
    id: a.id, nama: a.name, jabatan: a.role, ruangan: a.room, state: "working", bubble, updatedAt: now.toISOString(),
  }, null, 2));
}

function appendNotes(id: AgentId, entry: string) {
  const a = agent(id);
  const file = path.join(OFFICE_DIR, "agents", a.name.toLowerCase(), `CATATAN-${a.name.toUpperCase()}.md`);
  const prev = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : `# CATATAN-${a.name.toUpperCase()}\n`;
  write(file, `${prev.trimEnd()}\n\n${entry}\n`);
}

function sendInbox(fromId: AgentId, toId: AgentId, stamp: string, subject: string, body: string, now: Date) {
  const from = agent(fromId), to = agent(toId);
  write(path.join(OFFICE_DIR, "inbox", to.name.toLowerCase(), `${stamp}-${from.name.toLowerCase()}.json`), JSON.stringify({
    from: from.id, to: to.id, subject, body, createdAt: now.toISOString(), read: false,
  }, null, 2));
}

const d = (t: number) => new Date(t).toISOString().slice(0, 10);
const n = (x: number, dp = 2) => (Number.isFinite(x) ? x.toFixed(dp) : x > 0 ? "∞" : "-");
const pct = (x: number, dp = 1) => `${x > 0 ? "+" : ""}${n(x, dp)}%`;

function write(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

export function scanMarkdown(rows: ScanRow[], meta: { synthetic: boolean; equity: number; realEquity: number; createdAt: string }): string {
  const L: string[] = [];
  L.push(`# Laporan scan strategi — ${meta.createdAt}`);
  if (meta.synthetic) L.push("", "> **DATA SINTETIS.** Hasil ini hanya menguji mesin, bukan pasar. Jangan dipakai untuk keputusan trading.");
  L.push("", "## Asumsi",
    "- Entry di open bar setelah sinyal, slippage 0.02%, fee taker 0.05% / maker 0.02%",
    "- Funding tiap 8 jam (data asli Binance kalau tersedia, selain itu 0.01%)",
    "- SL & TP di bar yang sama dianggap SL dulu; gap melewati SL dieksekusi di open",
    "- Risk 1% per trade, leverage maks 5x, R:R min 1:2 (strategi target tetap), rugi harian maks 3%",
    `- Equity riset $${meta.equity.toLocaleString("en-US")}; cek kelayakan di equity kamu $${meta.realEquity}`,
    "- Peringkat memakai hasil **walk-forward out-of-sample**, bukan in-sample", "");
  L.push("## Peringkat (out-of-sample)", "",
    "| # | Aset | TF | Strategi | Trade | Win | PF | Exp. R | Return | Max DD | Hold | MC 5% terburuk | Vonis |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  rows.forEach((r, i) => {
    const m = r.wf.oos.metrics;
    L.push(`| ${i + 1} | ${r.symbol} | ${r.tf} | ${r.strategyName} | ${m.trades} | ${n(m.winRatePct, 0)}% | ${n(m.profitFactor)} | ${n(m.avgR)} | ${pct(m.returnPct)} | ${n(m.maxDrawdownPct, 1)}% | ${pct(r.wf.oos.buyHoldPct, 0)} | ${r.mc ? pct(r.mc.p5ReturnPct) : "-"} | ${r.verdict.label} |`);
  });
  L.push("");
  for (const r of rows.slice(0, 3)) {
    const m = r.wf.oos.metrics, dm = r.wf.defaultsOnSameSpan.metrics;
    L.push(`## ${r.symbol} ${r.tf} · ${r.strategyName}`, "",
      `Rentang OOS ${d(r.wf.oos.from)} → ${d(r.wf.oos.to)}, ${r.wf.windows.length} jendela, ${r.wf.combosTried} kombinasi parameter dicoba per jendela.`, "",
      `- Vonis: **${r.verdict.label}**`, ...r.verdict.reasons.map(x => `  - ${x}`),
      `- Return ${pct(m.returnPct)} · CAGR ${pct(m.cagrPct)} · Sharpe ${n(m.sharpe)} · max DD ${n(m.maxDrawdownPct, 1)}%`,
      `- Avg win ${n(m.avgWinR)}R · avg loss ${n(m.avgLossR)}R · rugi beruntun terpanjang ${m.maxLosingStreak}`,
      `- Fee ${n(m.feesPaid)} · funding bersih ${n(m.fundingNet)} · likuidasi ${m.liquidations} · exposure ${n(m.exposurePct, 0)}%`,
      `- Parameter default tanpa optimasi di rentang sama: return ${pct(dm.returnPct)}, PF ${n(dm.profitFactor)}, ${dm.trades} trade`,
      `- Kelayakan di equity $${r.feasibility.equity}: ${r.feasibility.accepted} dari ${r.feasibility.signals} sinyal bisa dieksekusi` +
        (r.feasibility.topRejection ? ` (alasan ditolak terbanyak: ${REJECTION_LABEL[r.feasibility.topRejection] ?? r.feasibility.topRejection})` : ""),
      "", "| Jendela test | Parameter dipilih | Return | Trade |", "|---|---|---|---|",
      ...r.wf.windows.map(w => `| ${d(w.testFrom)} → ${d(w.testTo)} | ${Object.entries(w.params).filter(([k]) => k in r.grid).map(([k, v]) => `${k}=${v}`).join(", ")} | ${pct(w.testReturnPct)} | ${w.testTrades} |`),
      "");
  }
  return L.join("\n");
}

export function writeScanToOffice(rows: ScanRow[], meta: { synthetic: boolean; equity: number; realEquity: number }) {
  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const createdAt = now.toLocaleString("id-ID", { timeZone: "Asia/Jakarta" }) + " WIB";
  const md = scanMarkdown(rows, { ...meta, createdAt });
  const base = path.join(OFFICE_DIR, "backtests", `scan-${stamp}`);
  write(`${base}.md`, md);
  write(`${base}.json`, JSON.stringify({ createdAt: now.toISOString(), ...meta, rows: rows.map(r => ({ ...r, wf: { ...r.wf, oos: { ...r.wf.oos, equity: undefined }, defaultsOnSameSpan: { ...r.wf.defaultsOnSameSpan, equity: undefined } } })) }, null, 2));

  const best = rows[0];
  const bubble = meta.synthetic
    ? "Tes mesin backtest selesai (data sintetis)"
    : best
      ? `Scan selesai. Teratas: ${best.symbol} ${best.tf} ${best.strategyId}, ${best.verdict.label.toLowerCase()}`
      : "Scan selesai, tidak ada hasil";
  writeAgentStatus("technical_analyst", bubble, now);

  const top = rows.slice(0, 5).map(r => `- ${r.symbol} ${r.tf} ${r.strategyId}: ${r.verdict.label} (OOS ${pct(r.wf.oos.metrics.returnPct)}, PF ${n(r.wf.oos.metrics.profitFactor)}, ${r.wf.oos.metrics.trades} trade)`);
  appendNotes("jurnal", `## Scan ${createdAt}${meta.synthetic ? " (sintetis)" : ""}\n${top.join("\n")}\n- Laporan: backtests/scan-${stamp}.md`);
  writeAgentStatus("jurnal", `Mencatat hasil scan ${createdAt}`, now);

  sendInbox("jurnal", "head_trader", stamp, meta.synthetic ? "Tes mesin backtest" : "Hasil scan strategi",
    `${bubble}. Detail di backtests/scan-${stamp}.md`, now);
  return `${base}.md`;
}

/** Hasil debat bull/bear ditulis sebagai usulan ke office/inbox/raka — menunggu approval manusia, tidak auto-eksekusi. */
export function writeDebatesToOffice(results: DebateResult[], meta: { realEquity: number }) {
  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const createdAt = now.toLocaleString("id-ID", { timeZone: "Asia/Jakarta" }) + " WIB";

  const L: string[] = [`# Debat bull/bear — ${createdAt}`, "", `Equity riset: $${meta.realEquity}`, "",
    "> Vonis \"go_paper\" berarti layak diuji di paper trading, bukan izin pakai uang asli. Keputusan akhir tetap manusia.", ""];
  for (const r of results) {
    L.push(`## ${r.symbol} ${r.tf} · ${r.strategyName}`, "",
      `**Vonis: ${r.verdict.toUpperCase()}** (confidence ${r.confidence}, risk disarankan ${r.suggestedRiskPct}% · model ${r.model})`, "",
      `**Bull:** ${r.bullCase}`, "", `**Bear:** ${r.bearCase}`, "", `**Keputusan:** ${r.reasoning}`, "");
  }
  const md = L.join("\n");
  const base = path.join(OFFICE_DIR, "debates", `debate-${stamp}`);
  write(`${base}.md`, md);
  write(`${base}.json`, JSON.stringify({ createdAt: now.toISOString(), ...meta, results }, null, 2));

  const goPaper = results.filter(r => r.verdict === "go_paper");
  const bubble = goPaper.length ? `${goPaper.length} dari ${results.length} kandidat lolos debat` : `Tidak ada kandidat lolos dari ${results.length} yang didebat`;
  writeAgentStatus("risk_manager", bubble, now);
  appendNotes("jurnal", `## Debat bull/bear ${createdAt}\n${results.map(r => `- ${r.symbol} ${r.tf} ${r.strategyId}: ${r.verdict}`).join("\n")}\n- Laporan: debates/debate-${stamp}.md`);
  writeAgentStatus("jurnal", `Mencatat hasil debat ${createdAt}`, now);

  sendInbox("risk_manager", "head_trader", stamp, "Hasil debat bull/bear",
    goPaper.length
      ? `${goPaper.length} dari ${results.length} kandidat lolos debat (go_paper): ${goPaper.map(r => `${r.symbol} ${r.tf} ${r.strategyId}`).join(", ")}. Butuh approval manual sebelum paper trading. Detail di debates/debate-${stamp}.md`
      : `Tidak ada kandidat yang lolos debat bull/bear dari ${results.length} yang diuji. Detail di debates/debate-${stamp}.md`,
    now);
  return `${base}.md`;
}
