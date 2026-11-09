// Head Trader: meringkas aktivitas scan + debat + eksekusi terakhir jadi laporan singkat buat user.
// Satu panggilan Claude, grounded ke file yang benar-benar ada di office/ — tidak mengarang aktivitas.
import fs from "node:fs";
import path from "node:path";
import { llmText } from "./llm.js";
import { OFFICE_DIR, writeAgentStatus } from "../report/office.js";
import { loadWatchlist } from "../exec/watchlist.js";
import { listPending } from "../exec/approvals.js";
import { loadState } from "../exec/state.js";
import { equityPoints, tradeRecords, wibDay } from "../ops/common.js";
import { REGIME_FILE } from "../ops/regime.js";
import { readCrowd } from "../ops/crowd.js";
import { readCalendar } from "../ops/calendar.js";
import { LAB_DIR } from "../ops/lab.js";

function latestFile(dir: string, ext: string): string | undefined {
  const full = path.join(OFFICE_DIR, dir);
  if (!fs.existsSync(full)) return undefined;
  const files = fs.readdirSync(full).filter(f => f.endsWith(ext)).sort();
  return files.length ? path.join(full, files[files.length - 1]!) : undefined;
}

function gatherFacts(): string {
  const parts: string[] = [];

  const scanFile = latestFile("backtests", ".json");
  if (scanFile) {
    const scan = JSON.parse(fs.readFileSync(scanFile, "utf8")) as { createdAt: string; rows: { symbol: string; tf: string; strategyId: string; verdict: { label: string } }[] };
    const candidates = scan.rows.filter(r => r.verdict.label === "Kandidat paper trading");
    parts.push(`Scan terakhir (${scan.createdAt}): ${scan.rows.length} kombinasi diuji, ${candidates.length} lolos "Kandidat paper trading": ${candidates.slice(0, 5).map(r => `${r.symbol} ${r.tf} ${r.strategyId}`).join(", ")}${candidates.length > 5 ? ", ..." : ""}.`);
  } else {
    parts.push("Belum ada scan yang pernah dijalankan.");
  }

  const debateFile = latestFile("debates", ".json");
  if (debateFile) {
    const debate = JSON.parse(fs.readFileSync(debateFile, "utf8")) as { createdAt: string; results: { symbol: string; tf: string; strategyId: string; verdict: string }[] };
    const goPaper = debate.results.filter(r => r.verdict === "go_paper");
    parts.push(`Debat bull/bear terakhir (${debate.createdAt}): ${debate.results.length} kandidat didebat, ${goPaper.length} go_paper: ${goPaper.map(r => `${r.symbol} ${r.tf} ${r.strategyId}`).join(", ") || "-"}.`);
  } else {
    parts.push("Belum ada debat bull/bear yang pernah dijalankan.");
  }

  const watchlist = loadWatchlist();
  parts.push(watchlist.length ? `Watchlist aktif bot: ${watchlist.map(w => `${w.symbol} ${w.tf} ${w.strategyId}`).join(", ")}.` : "Watchlist bot masih kosong.");

  const pending = listPending();
  parts.push(pending.length ? `Approval entry yang masih menunggu keputusan: ${pending.map(p => `${p.symbol} ${p.side} (${p.id})`).join(", ")}.` : "Tidak ada approval entry yang menunggu saat ini.");

  parts.push(...liveFacts());
  return parts.join("\n");
}

const readJson = <T>(f: string): T | null => { try { return JSON.parse(fs.readFileSync(f, "utf8")) as T; } catch { return null; } };
const money = (n: number) => `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}`;

/** Fakta kondisi live: akun, posisi, trade, regime, crowd, berita, Lab. Semua dari file office/, tanpa jaringan. */
function liveFacts(): string[] {
  const out: string[] = [];
  const now = Date.now();
  try {
    const pts = equityPoints();
    const last = pts.at(-1);
    if (last) {
      const today = wibDay(now);
      const start = pts.filter(p => wibDay(p.t) < today).at(-1)?.equity ?? pts.find(p => wibDay(p.t) === today)?.equity ?? last.equity;
      const weekAgo = pts.filter(p => Date.parse(p.t) <= now - 7 * 86_400_000).at(-1)?.equity;
      out.push(`Equity sekarang $${last.equity.toFixed(2)}; hari ini ${money(last.equity - start)}${weekAgo != null ? `; 7 hari ${money(last.equity - weekAgo)}` : ""}.`);
    }
  } catch { /* tidak ada data equity */ }
  try {
    const st = loadState();
    const open = Object.entries(st).filter(([, w]) => w.position).map(([k, w]) => `${k} ${w.position!.side} entry ${w.position!.entry} stop ${w.position!.stop}${w.position!.target != null ? ` target ${w.position!.target}` : ""}`);
    out.push(open.length ? `Posisi terbuka: ${open.join("; ")}.` : "Tidak ada posisi terbuka.");
  } catch { /* state belum ada */ }
  try {
    const ts = tradeRecords().filter(t => Date.parse(t.t) >= now - 7 * 86_400_000);
    if (ts.length) {
      const wins = ts.filter(t => t.pnl > 0).length;
      out.push(`Trade tertutup 7 hari: ${ts.length} (menang ${wins}), total ${money(ts.reduce((a, t) => a + t.pnl, 0))}, rata-rata ${(ts.reduce((a, t) => a + t.r, 0) / ts.length).toFixed(2)}R. Terakhir: ${ts.slice(-3).map(t => `${t.symbol} ${t.side} ${money(t.pnl)} (${t.reason})`).join("; ")}.`);
    } else out.push("Belum ada trade tertutup dalam 7 hari terakhir.");
  } catch { /* jurnal kosong */ }
  const reg = readJson<{ fits?: { symbol: string; tf: string; strategyId: string; fit: string; note: string }[] }>(REGIME_FILE);
  const bad = reg?.fits?.filter(f => f.fit === "kurang cocok") ?? [];
  if (reg?.fits) out.push(bad.length ? `Strategi yang kurang cocok dengan regime pasar sekarang: ${bad.map(f => `${f.symbol} ${f.strategyId} (${f.note})`).join("; ")}.` : "Semua strategi watchlist cocok/netral dengan regime pasar sekarang.");
  const crowd = readCrowd();
  if (crowd) {
    const hot = crowd.rows.filter(r => r.flag !== "normal");
    out.push(`Fear & Greed: ${crowd.fearGreed ? `${crowd.fearGreed.value} (${crowd.fearGreed.label})` : "tidak ada data"}. ${hot.length ? `Pasar "ramai": ${hot.map(r => `${r.symbol} ${r.flag}`).join(", ")}.` : "Tidak ada koin watchlist yang crowd-nya ekstrem."}`);
  }
  const cal = readCalendar();
  const nextHigh = cal?.events.filter(e => e.impact === "High" && Date.parse(e.at) > now && Date.parse(e.at) < now + 36 * 3_600_000) ?? [];
  if (cal) out.push(nextHigh.length ? `Berita high-impact 36 jam ke depan: ${nextHigh.slice(0, 4).map(e => `${e.country} ${e.title} ${new Date(Date.parse(e.at) + 7 * 3_600_000).toISOString().slice(5, 16).replace("T", " ")} WIB`).join("; ")}.` : "Tidak ada berita high-impact dalam 36 jam ke depan.");
  const labFile = latestFile(path.relative(OFFICE_DIR, LAB_DIR), ".json");
  const lab = labFile && path.basename(labFile).startsWith("lab-") ? readJson<{ createdAt: string; rows: { symbol: string; strategyId: string; status: string }[] }>(labFile) : null;
  const weak = lab?.rows.filter(r => ["melemah", "tanpa edge", "gagal"].includes(r.status)) ?? [];
  if (lab) out.push(weak.length ? `Lab R&D (${lab.createdAt.slice(0, 10)}) menandai: ${weak.map(r => `${r.symbol} ${r.strategyId} ${r.status}`).join(", ")}.` : `Lab R&D (${lab.createdAt.slice(0, 10)}): semua strategi watchlist stabil/membaik.`);
  return out;
}

export async function generateHeadTraderReport(model = process.env.HEADTRADER_MODEL ?? "claude-opus-5"): Promise<string> {
  const facts = gatherFacts();
  const { text } = await llmText({
    system: "Kamu Head Trader di meja trading futures crypto. Tulis laporan singkat (4-6 kalimat, bahasa biasa) untuk user berdasarkan HANYA fakta yang diberikan — jangan mengarang aktivitas yang tidak disebutkan. Fokus ke apa yang perlu diperhatikan user sekarang (kondisi akun, posisi, risiko seperti berita/crowd/regime, approval menunggu, kandidat baru). Jangan memberi sinyal beli/jual baru; bot hanya mengikuti strategi + Risk Engine.",
    user: facts, maxTokens: 1000, anthropicModel: model,
  });
  return text || "(laporan kosong)";
}

export function writeReport(slot: "pagi" | "sore", text: string) {
  const now = new Date();
  const dateStr = now.toLocaleDateString("id-ID", { timeZone: "Asia/Jakarta" }).split("/").reverse().join("-");
  const file = path.join(OFFICE_DIR, "reports", `${dateStr}-${slot}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `# Laporan Head Trader — ${slot === "pagi" ? "07:00" : "15:00"} WIB, ${dateStr}\n\n${text}\n`);
  writeAgentStatus("head_trader", `Laporan ${slot} selesai: ${text.slice(0, 100)}${text.length > 100 ? "..." : ""}`);
  return file;
}
