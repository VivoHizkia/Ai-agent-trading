// Kalender berita ekonomi (high-impact) untuk Meja Berita dan opsi blokir entry di bot.
// Sumber: feed JSON publik ForexFactory (tanpa API key). Ditulis ke office/market/calendar.json.
import fs from "node:fs";
import path from "node:path";
import { MARKET_DIR, writeJsonAtomic } from "./common.js";

export const CALENDAR_FILE = path.join(MARKET_DIR, "calendar.json");
const URLS = (process.env.CALENDAR_URLS ?? "https://nfs.faireconomy.media/ff_calendar_thisweek.json,https://nfs.faireconomy.media/ff_calendar_nextweek.json")
  .split(",").map(s => s.trim()).filter(Boolean);
/** Negara yang dianggap menggerakkan crypto. Default USD saja. */
const COUNTRIES = (process.env.CALENDAR_COUNTRIES ?? "USD").split(",").map(s => s.trim().toUpperCase());

export interface CalendarEvent { title: string; country: string; impact: "High" | "Medium" | "Low" | string; at: string; forecast: string; previous: string }
export interface CalendarFile { updatedAt: string; source: string; countries: string[]; events: CalendarEvent[] }

export async function refreshCalendar(): Promise<CalendarFile | null> {
  const events: CalendarEvent[] = [];
  let ok = 0;
  for (const url of URLS) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { "User-Agent": "trading-floor/1.0" } });
      if (!res.ok) continue;
      const rows = (await res.json()) as { title?: string; country?: string; date?: string; impact?: string; forecast?: string; previous?: string }[];
      ok++;
      for (const r of rows) {
        if (!r.title || !r.date || !r.country) continue;
        const t = Date.parse(r.date);
        if (!Number.isFinite(t)) continue;
        if (!COUNTRIES.includes(r.country.toUpperCase())) continue;
        if (r.impact !== "High" && r.impact !== "Medium") continue;
        events.push({ title: r.title, country: r.country, impact: r.impact, at: new Date(t).toISOString(), forecast: r.forecast ?? "", previous: r.previous ?? "" });
      }
    } catch { /* coba URL berikutnya */ }
  }
  if (!ok) return null; // jangan menimpa file lama kalau semua sumber gagal
  const uniq = [...new Map(events.map(e => [`${e.at}|${e.title}`, e])).values()].sort((a, b) => a.at.localeCompare(b.at));
  const file: CalendarFile = { updatedAt: new Date().toISOString(), source: "ForexFactory", countries: COUNTRIES, events: uniq };
  writeJsonAtomic(CALENDAR_FILE, file);
  return file;
}

export function readCalendar(): CalendarFile | null {
  try { return JSON.parse(fs.readFileSync(CALENDAR_FILE, "utf8")) as CalendarFile; } catch { return null; }
}

/** Berita HIGH impact yang jaraknya <= windowMs dari sekarang (sebelum atau sesudah). Null kalau aman / tidak ada data. */
export function activeBlackout(windowMs: number, now = Date.now()): (CalendarEvent & { minutes: number }) | null {
  const cal = readCalendar();
  if (!cal) return null;
  for (const e of cal.events) {
    if (e.impact !== "High") continue;
    const d = Date.parse(e.at) - now;
    if (Math.abs(d) <= windowMs) return { ...e, minutes: Math.round(d / 60_000) };
  }
  return null;
}
