// Mode demo: hanya visual di browser, tidak pernah menulis file. Dipakai saat office/ kosong
// atau saat Vivo ingin melihat kantor "hidup" tanpa bot jalan.
import type { AgentSlug, AgentState } from "@/lib/roster";

export interface DemoStep {
  states: Partial<Record<AgentSlug, [AgentState, string]>>;
  message?: { from: AgentSlug | "bos"; to: AgentSlug | "bos"; subject: string };
}

export const DEMO_START: Record<AgentSlug, [AgentState, string]> = {
  raka: ["working", "Rekap kandidat dari scan terakhir"],
  tio: ["working", "Scan top30 4h, cari kandidat baru"],
  sendi: ["working", "Funding BTC netral, OI datar"],
  rini: ["working", "Exposure 0%, belum ada posisi"],
  eko: ["working", "Standby DRY_RUN, pantau 3 pair"],
  lala: ["working", "Catat hasil scan ke jurnal"],
};

export const DEMO: DemoStep[] = [
  { states: { tio: ["working", "ADA 4h ema_adx: sinyal long baru"] }, message: { from: "tio", to: "raka", subject: "Sinyal ADA 4h long" } },
  { states: { raka: ["meeting", "Bahas sinyal ADA"], tio: ["meeting", "Bahas sinyal ADA"], sendi: ["meeting", "Bahas sinyal ADA"] } },
  { states: { sendi: ["alert", "Ada berita makro malam ini, tahan entry"] }, message: { from: "sendi", to: "raka", subject: "Flag: jangan entry dulu" } },
  { states: { raka: ["waiting_approval", "Setup ADA long nunggu izin Bos"], tio: ["working", "Scan BTC 1d, cari konfirmasi"], sendi: ["working", "Pantau likuidasi besar"] }, message: { from: "raka", to: "bos", subject: "Minta izin: ADA long" } },
  { states: { rini: ["working", "Cek risk ADA: 1%, R:R 1:2, lolos"] }, message: { from: "rini", to: "raka", subject: "Plan ADA lolos Risk Engine" } },
  { states: { lala: ["idle", "Rehat kopi, jurnal sudah update"], raka: ["working", "Susun plan berikutnya"] } },
  { states: { eko: ["working", "Pantau ARB 4h donchian"], lala: ["working", "Bandingkan OOS vs hold"] }, message: { from: "lala", to: "raka", subject: "Ringkasan jurnal harian" } },
];
