// Jalankan layanan kantor secara manual:
//   npm run lab        uji ulang strategi watchlist dengan data terbaru (Lab R&D)
//   npm run discover   scan top 100 koin, cari kandidat baru di luar watchlist
//   npm run livecheck  perbarui pembanding backtest, lalu bandingkan dengan trade live
//   npm run review     tulis review minggu ini (atau --last untuk minggu lalu)
//   npm run regime     hitung ulang regime market
//   npm run calendar   ambil ulang kalender berita
//   npm run crowd      ambil data crowd (funding, OI, long/short, Fear & Greed)
import "dotenv/config";
import { refreshCalendar } from "./calendar.js";
import { refreshCrowd } from "./crowd.js";
import { refreshRegime } from "./regime.js";
import { buildWeeklyReview, reviewMarkdown, writeWeeklyReview } from "./review.js";
import { runLab } from "./lab.js";
import { discoverTelegram, runDiscover } from "./discover.js";
import { buildExpectations, liveCheck, liveReportText } from "./livecheck.js";
import { tuneWatchlist, tuningTelegram } from "./tuning.js";

async function main() {
  const cmd = process.argv[2];
  if (cmd === "lab") {
    const { file, rows } = await runLab(m => console.log(m));
    for (const r of rows) console.log(`- ${r.symbol} ${r.tf} ${r.strategyId}: ${r.status} — ${r.note}`);
    console.log(`Ditulis: ${file}`);
  } else if (cmd === "discover") {
    const quiet = process.argv.includes("--quiet");
    const { file, result } = await runDiscover(m => { if (!quiet) console.log(m); });
    if (!quiet) console.log(discoverTelegram(result).replace(/<[^>]+>/g, ""));
    console.log(`Ditulis: ${file}`);
  } else if (cmd === "livecheck") {
    const quiet = process.argv.includes("--quiet");
    if (!process.argv.includes("--no-refresh")) await buildExpectations(m => { if (!quiet) console.log(m); });
    if (!quiet) console.log(liveReportText(liveCheck()).replace(/<[^>]+>/g, ""));
  } else if (cmd === "tune") {
    const changes = await tuneWatchlist({ force: process.argv.includes("--force"), onProgress: m => console.log(m) });
    console.log(tuningTelegram(changes).replace(/<[^>]+>/g, ""));
  } else if (cmd === "review") {
    const t = process.argv.includes("--last") ? Date.now() - 7 * 86_400_000 : Date.now();
    const r = buildWeeklyReview(t);
    writeWeeklyReview(r);
    console.log(reviewMarkdown(r));
  } else if (cmd === "regime") {
    const r = await refreshRegime();
    if (!r) return console.log("Gagal mengambil data regime.");
    for (const x of r.rows) console.log(`${x.symbol}: ${x.label} (ADX ${x.adx.toFixed(0)}, ATR ${x.atrPct.toFixed(2)}%)`);
    for (const f of r.fits) console.log(`- ${f.symbol} ${f.tf} ${f.strategyId}: ${f.fit} — ${f.note}`);
  } else if (cmd === "calendar") {
    const c = await refreshCalendar();
    if (!c) return console.log("Sumber kalender tidak bisa diakses.");
    for (const e of c.events) console.log(`${e.at} ${e.impact} ${e.country} ${e.title}`);
  } else if (cmd === "crowd") {
    const c = await refreshCrowd();
    if (!c) return console.log("Data crowd tidak bisa diambil.");
    if (c.fearGreed) console.log(`Fear & Greed: ${c.fearGreed.value} (${c.fearGreed.label}) — sumber alternative.me`);
    for (const r of c.rows) console.log(`${r.symbol}: funding ${r.funding != null ? (r.funding * 100).toFixed(4) + "%" : "?"}, OI 24j ${r.oiChg24h?.toFixed(1) ?? "?"}%, L/S ${r.lsRatio?.toFixed(2) ?? "?"}, taker ${r.takerRatio?.toFixed(2) ?? "?"} → ${r.flag}`);
  } else {
    console.log("Pakai: npm run crowd | npm run lab | npm run discover | npm run livecheck | npm run tune [-- --force] | npm run review [-- --last] | npm run regime | npm run calendar");
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
