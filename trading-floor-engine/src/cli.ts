// CLI: fetch | backtest | walkforward | scan | debate
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import type { Candle, FundingRate, Timeframe } from "./types.js";
import { TF_MS } from "./types.js";
import { fetch24hQuoteVolume, fetchAllSymbols, fetchFunding, fetchKlines } from "./data/binance.js";
import { candlePath, fundingPath, loadCandles, loadCsv, loadFunding, saveJson } from "./data/store.js";
import { syntheticCandles, syntheticFunding } from "./data/synthetic.js";
import { STRATEGIES, getStrategy, type Params } from "./strategies/index.js";
import { runBacktest } from "./backtest/engine.js";
import { walkForward } from "./backtest/walkforward.js";
import { monteCarlo } from "./backtest/montecarlo.js";
import { verdict } from "./backtest/verdict.js";
import { REJECTION_LABEL } from "./risk/engine.js";
import { rankRows, scanOne, type ScanRow } from "./scan.js";
import { OFFICE_DIR, writeDebatesToOffice, writeScanToOffice } from "./report/office.js";
import { runDebate, type DebateResult } from "./agents/debate.js";
import { decide, listPending } from "./exec/approvals.js";
import { runSentiment } from "./agents/sentiment.js";
import { llmProvider } from "./agents/llm.js";

const USER_EQUITY = 81.01; // spot BTC $53.12 + XRP $27.89 (23 Okt 2026)

function parseArgs(argv: string[]) {
  const a: Record<string, string> = {}; const params: Params = {}; const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    if (!k.startsWith("--")) continue;
    const name = k.slice(2), next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) { flags.add(name); continue; }
    if (name === "param") { const [pk, pv] = next.split("="); params[pk!] = Number(pv); } else a[name] = next;
    i++;
  }
  return { a, params, flags };
}

const list = (s: string | undefined, d: string) => (s ?? d).split(/[,\s]+/).map(x => x.trim()).filter(Boolean);

/** `--symbols all` = semua pair USDT-M perpetual Binance, diurutkan dari paling likuid; `--top N` membatasi jumlahnya. */
async function resolveSymbols(s: string | undefined, top: string | undefined): Promise<string[]> {
  if ((s ?? "").toLowerCase() !== "all") return list(s, "BTCUSDT,XRPUSDT");
  const symbols = await fetchAllSymbols();
  const volume = await fetch24hQuoteVolume();
  const sorted = symbols.sort((a, b) => (volume[b] ?? 0) - (volume[a] ?? 0));
  return top ? sorted.slice(0, Number(top)) : sorted;
}

const TF_ALIAS: Record<string, Timeframe> = { "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d", d: "1d", "1": "1d", daily: "1d", "4": "4h" };
/** PowerShell mengubah `1d` jadi angka 1 dan `4h,1d` jadi array; terima bentuk itu dan tolak yang tidak dikenal. */
function tfList(s: string | undefined, d: string): Timeframe[] {
  return list(s, d).map(x => {
    const tf = TF_ALIAS[x.toLowerCase()];
    if (!tf) throw new Error(`Timeframe '${x}' tidak dikenal. Pilihan: 15m, 1h, 4h, 1d. Di PowerShell, beri tanda kutip: --tfs "4h,1d"`);
    return tf;
  });
}
const day = (s: string) => Date.parse(s + "T00:00:00Z");
const fmtD = (t: number) => new Date(t).toISOString().slice(0, 10);
const n = (x: number, dp = 2) => (Number.isFinite(x) ? x.toFixed(dp) : x > 0 ? "inf" : "-");
const pct = (x: number) => `${x > 0 ? "+" : ""}${n(x, 1)}%`;

function getData(symbol: string, tf: Timeframe, a: Record<string, string>, synthetic: boolean, seed: number): { candles: Candle[]; funding: FundingRate[] } {
  let candles: Candle[];
  let funding: FundingRate[] = [];
  if (synthetic) {
    const days = Number(a.days ?? 1600);
    candles = syntheticCandles({ bars: Math.round((days * 86_400_000) / TF_MS[tf]), tf, seed, start: Math.floor(Date.now() / 86_400_000 - days) * 86_400_000, price: symbol.startsWith("XRP") ? 0.6 : 40_000 });
    funding = syntheticFunding(candles, seed + 1);
  } else if (a.data) {
    candles = loadCsv(a.data);
  } else {
    candles = loadCandles(symbol, tf);
    funding = loadFunding(symbol);
  }
  const from = a.from ? day(a.from) : -Infinity, to = a.to ? day(a.to) + 86_400_000 : Infinity;
  candles = candles.filter(c => c.t >= from && c.t < to);
  return { candles, funding };
}

async function cmdFetch(a: Record<string, string>) {
  const from = day(a.from ?? "2020-01-01"), to = a.to ? day(a.to) + 86_400_000 : Date.now();
  const symbols = await resolveSymbols(a.symbol ?? a.symbols, a.top);
  console.log(`${symbols.length} simbol: ${symbols.join(", ")}`);
  for (const symbol of symbols) {
    for (const tf of tfList(a.tf ?? a.tfs, "4h,1d")) {
      process.stdout.write(`Ambil ${symbol} ${tf} ... `);
      try {
        const k = await fetchKlines(symbol, tf, from, to);
        saveJson(candlePath(symbol, tf), k);
        console.log(`${k.length} candle (${k[0] ? fmtD(k[0].t) : "-"} → ${k.length ? fmtD(k[k.length - 1]!.t) : "-"})`);
      } catch (e) { console.log(`dilewati: ${(e as Error).message}`); }
    }
    process.stdout.write(`Ambil funding ${symbol} ... `);
    try {
      const f = await fetchFunding(symbol, from, to);
      // Gabung dengan riwayat lama: fetch dengan --from yang lebih baru tidak boleh menghapus funding tahun-tahun sebelumnya.
      const merged = [...new Map([...loadFunding(symbol), ...f].map(x => [x.t, x])).values()].sort((a, b) => a.t - b.t);
      saveJson(fundingPath(symbol), merged);
      console.log(`${f.length} settlement baru, total ${merged.length}`);
    } catch (e) { console.log(`dilewati: ${(e as Error).message}`); }
  }
}

function cmdBacktest(a: Record<string, string>, params: Params, synthetic: boolean) {
  const symbol = a.symbol ?? "BTCUSDT", tf = tfList(a.tf, "1d")[0]!;
  const def = getStrategy(a.strategy ?? "donchian");
  const { candles, funding } = getData(symbol, tf, a, synthetic, 11);
  const p = { ...def.defaults, ...params };
  const r = runBacktest(candles, def.create(p), { symbol, tf, initialEquity: Number(a.equity ?? 10_000) }, funding);
  const m = r.metrics;
  console.log(`\n${symbol} ${tf} · ${def.name}${synthetic ? " · DATA SINTETIS" : ""}`);
  console.log(`Parameter: ${JSON.stringify(p)}`);
  console.log(`Rentang ${fmtD(r.from)} → ${fmtD(r.to)} (${n(m.years, 1)} tahun) · IN-SAMPLE, bukan bukti edge\n`);
  console.table({
    Trade: m.trades, "Win rate": `${n(m.winRatePct, 1)}%`, "Profit factor": n(m.profitFactor), "Expectancy (R)": n(m.avgR),
    Return: pct(m.returnPct), CAGR: pct(m.cagrPct), "Max DD": `${n(m.maxDrawdownPct, 1)}%`, Sharpe: n(m.sharpe),
    "Hold spot": pct(r.buyHoldPct), Fee: n(m.feesPaid), "Funding bersih": n(m.fundingNet), Likuidasi: m.liquidations,
  });
  printRejections(r.signals, r.rejections);
  const mc = monteCarlo(r.trades.map(t => t.r));
  if (mc) console.log(`Monte Carlo (${mc.sims}x): median ${pct(mc.medianReturnPct)}, 5% terburuk ${pct(mc.p5ReturnPct)}, DD 5% terburuk ${n(mc.p95MaxDDPct, 1)}%`);
}

function printRejections(signals: number, rej: Record<string, number>) {
  const e = Object.entries(rej);
  if (!e.length) return console.log(`Sinyal: ${signals}, semua lolos Risk Engine.`);
  console.log(`Sinyal: ${signals}. Ditolak Risk Engine / batal:`);
  for (const [k, v] of e.sort((x, y) => y[1] - x[1])) console.log(`  - ${REJECTION_LABEL[k] ?? k}: ${v}`);
}

function bars(tf: Timeframe, days: number) { return Math.round((days * 86_400_000) / TF_MS[tf]); }

function cmdWalkforward(a: Record<string, string>, synthetic: boolean) {
  const symbol = a.symbol ?? "BTCUSDT", tf = tfList(a.tf, "1d")[0]!;
  const def = getStrategy(a.strategy ?? "donchian");
  const { candles, funding } = getData(symbol, tf, a, synthetic, 11);
  const wf = walkForward(candles, def, { symbol, tf, initialEquity: Number(a.equity ?? 10_000) }, funding,
    { trainBars: bars(tf, Number(a["train-days"] ?? 365)), testBars: bars(tf, Number(a["test-days"] ?? 90)) });
  const m = wf.oos.metrics;
  const mc = monteCarlo(wf.oos.trades.map(t => t.r));
  const v = verdict(m, mc, wf.oos.buyHoldPct);
  console.log(`\nWalk-forward ${symbol} ${tf} · ${def.name}${synthetic ? " · DATA SINTETIS" : ""}`);
  console.log(`OOS ${fmtD(wf.oos.from)} → ${fmtD(wf.oos.to)} · ${wf.windows.length} jendela · ${wf.combosTried} kombinasi/jendela\n`);
  console.table(wf.windows.map(w => ({
    "Test": `${fmtD(w.testFrom)} → ${fmtD(w.testTo)}`,
    Parameter: Object.entries(w.params).filter(([k]) => k in def.grid).map(([k, x]) => `${k}=${x}`).join(" "),
    Return: pct(w.testReturnPct), Trade: w.testTrades,
  })));
  console.log(`OOS: ${m.trades} trade · win ${n(m.winRatePct, 1)}% · PF ${n(m.profitFactor)} · ${n(m.avgR)}R · return ${pct(m.returnPct)} · max DD ${n(m.maxDrawdownPct, 1)}% · hold ${pct(wf.oos.buyHoldPct)}`);
  console.log(`Default tanpa optimasi di rentang sama: return ${pct(wf.defaultsOnSameSpan.metrics.returnPct)}, PF ${n(wf.defaultsOnSameSpan.metrics.profitFactor)}`);
  console.log(`Vonis: ${v.label}`); v.reasons.forEach(x => console.log(`  - ${x}`));
}

async function cmdScan(a: Record<string, string>, synthetic: boolean, noOffice: boolean) {
  const symbols = await resolveSymbols(a.symbols ?? a.symbol, a.top);
  const tfs = tfList(a.tfs ?? a.tf, "4h,1d");
  const defs = a.strategies ? list(a.strategies, "").map(getStrategy) : STRATEGIES;
  const equity = Number(a.equity ?? 10_000), realEquity = Number(a["real-equity"] ?? USER_EQUITY);
  const rows: ScanRow[] = [];
  let seed = 11;
  for (const symbol of symbols) for (const tf of tfs) {
    let data: { candles: Candle[]; funding: FundingRate[] };
    try { data = getData(symbol, tf, a, synthetic, seed++); }
    catch (e) { console.log(`${symbol} ${tf} dilewati: ${(e as Error).message}`); continue; }
    const { candles, funding } = data;
    for (const def of defs) {
      process.stdout.write(`${symbol} ${tf} ${def.id} ... `);
      try {
        const row = scanOne(symbol, tf, candles, funding, def, {
          trainBars: bars(tf, Number(a["train-days"] ?? 365)), testBars: bars(tf, Number(a["test-days"] ?? 90)), equity, realEquity,
        });
        rows.push(row);
        console.log(`${row.wf.oos.metrics.trades} trade OOS, ${row.verdict.label}`);
      } catch (e) { console.log(`dilewati: ${(e as Error).message}`); }
    }
  }
  const ranked = rankRows(rows);
  console.log(`\nPeringkat (walk-forward out-of-sample)${synthetic ? " · DATA SINTETIS" : ""}`);
  console.table(ranked.map(r => {
    const m = r.wf.oos.metrics;
    return {
      Aset: r.symbol, TF: r.tf, Strategi: r.strategyId, Trade: m.trades, Win: `${n(m.winRatePct, 0)}%`, PF: n(m.profitFactor),
      "Exp R": n(m.avgR), Return: pct(m.returnPct), "Max DD": `${n(m.maxDrawdownPct, 1)}%`, Hold: pct(r.wf.oos.buyHoldPct),
      [`Bisa di $${realEquity}`]: `${r.feasibility.accepted}/${r.feasibility.signals}`, Vonis: r.verdict.label,
    };
  }));
  if (!noOffice) console.log(`\nLaporan: ${writeScanToOffice(ranked, { synthetic, equity, realEquity })}`);
}

function latestScanJson(): string | undefined {
  const dir = path.join(OFFICE_DIR, "backtests");
  if (!fs.existsSync(dir)) return undefined;
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".json")).sort();
  return files.length ? path.join(dir, files[files.length - 1]!) : undefined;
}

async function cmdDebate(a: Record<string, string>, flags: Set<string>) {
  const file = a.file ?? latestScanJson();
  if (!file) throw new Error("Belum ada laporan scan tersimpan. Jalankan npm run scan dulu.");
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as { realEquity: number; rows: ScanRow[] };
  const top = Number(a.top ?? 5);
  const pool = flags.has("all") ? data.rows : data.rows.filter(r => r.verdict.level === "kandidat_paper");
  const rows = pool.slice(0, top);
  if (!rows.length) { console.log("Tidak ada kandidat untuk didebat (coba --all untuk semua vonis)."); return; }
  console.log(`Debat ${rows.length} kandidat dari ${file} (AI: ${llmProvider()})`);
  const results: DebateResult[] = [];
  for (const row of rows) {
    process.stdout.write(`${row.symbol} ${row.tf} ${row.strategyId} ... `);
    try {
      const r = await runDebate(row, { realEquity: data.realEquity, model: a.model });
      results.push(r);
      console.log(`${r.verdict} (confidence ${r.confidence})`);
    } catch (e) { console.log(`gagal: ${(e as Error).message}`); }
  }
  if (!results.length) return;
  console.log(`\nLaporan debat: ${writeDebatesToOffice(results, { realEquity: data.realEquity })}`);
}

function cmdApprovals(a: Record<string, string>) {
  if (a.approve) { const r = decide(a.approve, "approved"); console.log(`${r.id}: ${r.status}`); return; }
  if (a.reject) { const r = decide(a.reject, "rejected"); console.log(`${r.id}: ${r.status}`); return; }
  const pending = listPending();
  if (!pending.length) { console.log("Tidak ada approval entry yang menunggu."); return; }
  for (const p of pending) {
    console.log(`${p.id}\n  ${p.symbol} ${p.tf} ${p.strategyId} · ${p.side} qty ${p.qty} leverage ${p.leverage}x · stop ${p.stop}${p.target ? ` target ${p.target}` : ""} · risk $${p.riskUsd.toFixed(2)}\n  Alasan: ${p.reason}`);
  }
  console.log(`\nApprove: npm run approvals -- --approve <id>\nReject:  npm run approvals -- --reject <id>`);
}

async function cmdSentiment(a: Record<string, string>) {
  const symbol = a.symbol ?? "BTCUSDT";
  const r = await runSentiment(symbol, a.model);
  console.log(`\n${r.symbol} — ${r.flag.toUpperCase()}`);
  console.log(`Funding terbaru: ${r.latestFundingRate !== null ? (r.latestFundingRate * 100).toFixed(4) + "%" : "-"}`);
  console.log(`Perubahan OI: ${r.oiChangePct !== null ? (r.oiChangePct > 0 ? "+" : "") + r.oiChangePct.toFixed(1) + "%" : "-"}`);
  if (r.upcomingEvents.length) console.log(`Event: ${r.upcomingEvents.map(e => `${e.title} (${e.date})`).join("; ")}`);
  console.log(`\n${r.narrative}`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { a, params, flags } = parseArgs(rest);
  const synthetic = flags.has("synthetic");
  switch (cmd) {
    case "fetch": return cmdFetch(a);
    case "backtest": return cmdBacktest(a, params, synthetic);
    case "walkforward": return cmdWalkforward(a, synthetic);
    case "scan": return cmdScan(a, synthetic, flags.has("no-office"));
    case "debate": return cmdDebate(a, flags);
    case "approvals": return cmdApprovals(a);
    case "sentiment": return cmdSentiment(a);
    default:
      console.log(`Pemakaian:
  npm run fetch -- --symbols BTCUSDT,XRPUSDT --tfs 4h,1d --from 2020-01-01
  npm run backtest -- --symbol BTCUSDT --tf 1d --strategy donchian [--param n=40] [--equity 10000]
  npm run walkforward -- --symbol XRPUSDT --tf 4h --strategy ema_adx [--train-days 365 --test-days 90]
  npm run scan -- [--symbols ..] [--tfs ..] [--strategies ..] [--real-equity 81.01]
  npm run demo   (scan di data sintetis, tanpa internet)
  npm run debate -- [--file office/backtests/scan-....json] [--top 5] [--all] [--model claude-opus-5]
    (butuh GEMINI_API_KEY / OPENROUTER_API_KEY / ANTHROPIC_API_KEY; debat bull/bear atas kandidat scan, hasil masuk office/inbox/raka untuk approval manual)
  npm run approvals -- [--approve <id>] [--reject <id>]   (tanpa flag: list yang masih pending)
  npm run sentiment -- --symbol ADAUSDT   (butuh GEMINI_API_KEY / OPENROUTER_API_KEY / ANTHROPIC_API_KEY)
Strategi: ${STRATEGIES.map(s => s.id).join(", ")}`);
  }
}

main().catch(e => { console.error(`Error: ${e.message}`); process.exit(1); });
