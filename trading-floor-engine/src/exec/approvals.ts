// Approval queue: Eksekutor WAJIB nunggu keputusan manusia sebelum entry baru dieksekusi.
// SL/TP (exit) tidak lewat sini — itu order asli yang sudah duduk di exchange begitu posisi dibuka.
import fs from "node:fs";
import path from "node:path";
import { OFFICE_DIR } from "../report/office.js";
import type { Side } from "../types.js";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export interface ApprovalRequest {
  id: string;
  createdAt: string;
  symbol: string;
  tf: string;
  strategyId: string;
  side: Side;
  qty: number;
  stop: number;
  target?: number;
  leverage: number;
  riskUsd: number;
  reason: string;
  status: ApprovalStatus;
  decidedAt?: string;
}

const DIR = path.join(OFFICE_DIR, "approvals");
const filePath = (id: string) => path.join(DIR, `${id}.json`);

function write(req: ApprovalRequest) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(filePath(req.id), JSON.stringify(req, null, 2));
}

export function createApproval(input: Omit<ApprovalRequest, "id" | "createdAt" | "status">): ApprovalRequest {
  const req: ApprovalRequest = { ...input, id: `${Date.now()}-${input.symbol}-${input.strategyId}`, createdAt: new Date().toISOString(), status: "pending" };
  write(req);
  return req;
}

export function readApproval(id: string): ApprovalRequest | null {
  if (!fs.existsSync(filePath(id))) return null;
  return JSON.parse(fs.readFileSync(filePath(id), "utf8")) as ApprovalRequest;
}

export function listPending(): ApprovalRequest[] {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).filter(f => f.endsWith(".json"))
    .map(f => JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")) as ApprovalRequest)
    .filter(r => r.status === "pending");
}

/** Dipanggil UI (Fase 2) atau manual (edit file / CLI) untuk memutuskan. */
export function decide(id: string, status: "approved" | "rejected"): ApprovalRequest {
  const req = readApproval(id);
  if (!req) throw new Error(`Approval '${id}' tidak ditemukan`);
  if (req.status !== "pending") return req;
  req.status = status;
  req.decidedAt = new Date().toISOString();
  write(req);
  return req;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Satu kali cek, tidak nunggu — dipakai bot.ts tiap tick supaya satu approval lama tidak menahan simbol lain. */
export function checkStatus(id: string, timeoutMs: number): ApprovalStatus {
  const req = readApproval(id);
  if (!req) return "expired";
  if (req.status === "pending" && Date.now() - new Date(req.createdAt).getTime() >= timeoutMs) {
    req.status = "expired";
    req.decidedAt = new Date().toISOString();
    write(req);
  }
  return req.status;
}

/** Poll BLOCKING sampai approved/rejected/expired — cuma untuk CLI/test sekali-jalan, JANGAN dipakai di loop bot (menahan tick lain). */
export async function waitForDecision(id: string, timeoutMs: number, pollMs = 5_000): Promise<ApprovalStatus> {
  for (;;) {
    const status = checkStatus(id, timeoutMs);
    if (status !== "pending") return status;
    await sleep(pollMs);
  }
}
