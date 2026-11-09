// Data murni, tanpa modul Node — aman diimpor dari komponen klien.
// Nama & id mengikuti trading-floor-engine/src/agents/roster.ts (sumber kebenaran).

export type EngineAgentId =
  | "head_trader"
  | "technical_analyst"
  | "sentiment_analyst"
  | "risk_manager"
  | "executor"
  | "jurnal";

/** slug = nama folder di office/agents/<slug> dan office/inbox/<slug>. */
export type AgentSlug = "raka" | "tio" | "sendi" | "rini" | "eko" | "lala";

export type RoomId = "lobby" | "riset" | "risk" | "exec" | "meeting" | "jurnal" | "lounge" | "bos" | "ops" | "regime" | "berita" | "lab" | "review" | "scalp";

export interface AgentDef {
  slug: AgentSlug;
  engineId: EngineAgentId;
  nama: string;
  jabatan: string;
  divisi: string;
  room: RoomId;
  /** Kursi kerja di grid isometrik (gx, gy). */
  seat: [number, number];
  shirt: string;
  hair: string;
}

export const ROSTER: AgentDef[] = [
  { slug: "raka", engineId: "head_trader", nama: "Raka", jabatan: "Head Trader", divisi: "Trading", room: "lobby", seat: [5, 4], shirt: "#d9774f", hair: "#3a2a22" },
  { slug: "tio", engineId: "technical_analyst", nama: "Tio", jabatan: "Analis Teknikal", divisi: "Riset", room: "riset", seat: [10, 3], shirt: "#5aa6c9", hair: "#1f1a1a" },
  { slug: "sendi", engineId: "sentiment_analyst", nama: "Sendi", jabatan: "Analis Sentimen", divisi: "Riset", room: "riset", seat: [14, 3], shirt: "#8a7fd0", hair: "#4a3020" },
  { slug: "rini", engineId: "risk_manager", nama: "Rini", jabatan: "Risk Manager", divisi: "Risk", room: "risk", seat: [19, 4], shirt: "#4f9a6e", hair: "#5a3324" },
  { slug: "eko", engineId: "executor", nama: "Eko", jabatan: "Eksekutor", divisi: "Execution", room: "exec", seat: [26, 4], shirt: "#c9a341", hair: "#2e2218" },
  { slug: "lala", engineId: "jurnal", nama: "Lala", jabatan: "Jurnal & Evaluasi", divisi: "Jurnal", room: "jurnal", seat: [12, 11], shirt: "#d0698f", hair: "#6a3a28" },
];

export const ROOMS: { id: RoomId; name: string }[] = [
  { id: "lobby", name: "Lobby" },
  { id: "riset", name: "Ruang Riset" },
  { id: "risk", name: "Risk Desk" },
  { id: "exec", name: "Execution Room" },
  { id: "scalp", name: "Ruang Scalping" },
  { id: "meeting", name: "Ruang Meeting" },
  { id: "jurnal", name: "Ruang Jurnal" },
  { id: "lounge", name: "Lounge & Pool" },
  { id: "bos", name: "Ruang Bos" },
  { id: "ops", name: "Ruang Server" },
  { id: "regime", name: "Ruang Regime" },
  { id: "berita", name: "Meja Berita" },
  { id: "lab", name: "Lab R&D" },
  { id: "review", name: "Ruang Review" },
];

/** Id apa pun yang muncul di file (engine id, slug, "bos") → slug/label tampilan. */
export function resolveWho(id: string): { slug: AgentSlug | "bos" | null; nama: string } {
  if (id === "bos" || id === "boss") return { slug: "bos", nama: "Bos" };
  const a = ROSTER.find(r => r.slug === id || r.engineId === id);
  return a ? { slug: a.slug, nama: a.nama } : { slug: null, nama: id };
}

export const STATES = ["idle", "working", "waiting_approval", "meeting", "alert", "offline"] as const;
export type AgentState = (typeof STATES)[number];

export const STATE_LABEL: Record<AgentState, string> = {
  idle: "idle",
  working: "kerja",
  waiting_approval: "nunggu izin",
  meeting: "meeting",
  alert: "alert",
  offline: "offline",
};
