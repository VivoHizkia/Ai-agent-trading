// Daftar 6 agent Trading Floor. Dipakai office.ts untuk tahu siapa menulis bubble/inbox apa.
export type AgentId = "head_trader" | "technical_analyst" | "sentiment_analyst" | "risk_manager" | "executor" | "jurnal";

export interface AgentDef {
  id: AgentId;
  name: string;
  role: string;
  room: string;
}

export const ROSTER: AgentDef[] = [
  { id: "head_trader", name: "Raka", role: "Head Trader", room: "Ruang Meeting" },
  { id: "technical_analyst", name: "Tio", role: "Analis Teknikal", room: "Riset" },
  { id: "sentiment_analyst", name: "Sendi", role: "Analis Sentimen", room: "Riset" },
  { id: "risk_manager", name: "Rini", role: "Risk Manager", room: "Risk Desk" },
  { id: "executor", name: "Eko", role: "Eksekutor", room: "Execution Room" },
  { id: "jurnal", name: "Lala", role: "Jurnal & Evaluasi", room: "Jurnal" },
];

export function agent(id: AgentId): AgentDef {
  const a = ROSTER.find(x => x.id === id);
  if (!a) throw new Error(`Agent '${id}' tidak ada di roster`);
  return a;
}
