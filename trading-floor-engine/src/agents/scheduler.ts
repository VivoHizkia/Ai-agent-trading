// Proses long-running: panggil Head Trader sekali tiap jam 07:00 dan 15:00 WIB.
// Tidak dobel karena ditandai lewat keberadaan file laporan hari itu (office/reports/<tanggal>-<slot>.md).
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { OFFICE_DIR } from "../report/office.js";
import { generateHeadTraderReport, writeReport } from "./headtrader.js";

const CHECK_MS = 60_000;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function log(line: string) {
  const stamp = new Date().toISOString();
  console.log(`[${stamp}] ${line}`);
}

function wibNow(): { hour: number; minute: number; dateStr: string } {
  const now = new Date();
  const wib = new Date(now.getTime() + 7 * 3_600_000);
  return { hour: wib.getUTCHours(), minute: wib.getUTCMinutes(), dateStr: wib.toISOString().slice(0, 10) };
}

function reportExists(dateStr: string, slot: "pagi" | "sore"): boolean {
  return fs.existsSync(path.join(OFFICE_DIR, "reports", `${dateStr}-${slot}.md`));
}

async function fireIfDue() {
  const { hour, minute, dateStr } = wibNow();
  const slot: "pagi" | "sore" | null = hour === 7 ? "pagi" : hour === 15 ? "sore" : null;
  if (!slot || minute > 4) return; // toleransi 4 menit dari jam tepat
  if (reportExists(dateStr, slot)) return;
  log(`Memanggil Head Trader untuk laporan ${slot}...`);
  try {
    const text = await generateHeadTraderReport();
    const file = writeReport(slot, text);
    log(`Laporan ditulis: ${file}`);
  } catch (e) {
    log(`Gagal bikin laporan ${slot}: ${(e as Error).message}`);
  }
}

async function main() {
  log("Scheduler dimulai — cek tiap menit, laporan jam 07:00 & 15:00 WIB.");
  for (;;) {
    await fireIfDue();
    await sleep(CHECK_MS);
  }
}

main().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
