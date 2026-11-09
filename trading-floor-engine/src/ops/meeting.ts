// "Meeting" di kantor virtual: notifier menulis office/meetings/current.json saat ada briefing Head Trader
// atau kejadian penting (crowd ramai, regime berubah, rugi harian). Dashboard memindahkan agent peserta ke
// Ruang Meeting selama durasinya. Murni tampilan/catatan, tidak mempengaruhi bot.
import path from "node:path";
import { OFFICE_DIR } from "../report/office.js";
import { writeJsonAtomic } from "./common.js";

export const MEETING_FILE = path.join(OFFICE_DIR, "meetings", "current.json");
const MEETING_MINUTES = Number(process.env.MEETING_MINUTES ?? 15);

export type MeetingKind = "briefing" | "darurat";
export interface Meeting {
  kind: MeetingKind;
  title: string;          // judul singkat di TV, mis. "Briefing pagi"
  agenda: string;         // isi singkat
  attendees: string[];    // slug UI: raka, tio, sendi, rini, eko, lala
  at: string;
  until: string;
}

export function callMeeting(kind: MeetingKind, title: string, agenda: string, attendees: string[]) {
  const now = Date.now();
  const m: Meeting = {
    kind, title, agenda: agenda.replace(/\s+/g, " ").trim().slice(0, 240), attendees,
    at: new Date(now).toISOString(), until: new Date(now + MEETING_MINUTES * 60_000).toISOString(),
  };
  try { writeJsonAtomic(MEETING_FILE, m); } catch { /* tampilan saja, jangan ganggu notifier */ }
}
