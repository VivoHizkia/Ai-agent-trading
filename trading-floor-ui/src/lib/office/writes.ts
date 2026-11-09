import "server-only";
import fs from "node:fs";
import { exists, officePath, writeAtomic } from "./fsx";

// SATU-SATUNYA tempat UI menulis ke office/ (aturan keras no. 4 di CLAUDE.md):
//   - approvals/<id>.json: hanya field status, catatanBos, decidedAt
//   - execution/STOP: kill switch
// Tidak ada kode lain di src/ yang boleh menulis file.

const ID_RE = /^[A-Za-z0-9._-]{1,160}$/;

export class WriteError extends Error {
  constructor(message: string, readonly code: number) {
    super(message);
  }
}

export function decideApproval(id: string, status: "approved" | "rejected", catatanBos: string) {
  if (!ID_RE.test(id) || id.includes("..")) throw new WriteError("Id approval tidak sah", 400);
  const file = officePath("approvals", `${id}.json`);
  if (!exists(file)) throw new WriteError("Approval tidak ditemukan", 404);

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new WriteError("File approval rusak, tidak diubah", 422);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new WriteError("File approval rusak, tidak diubah", 422);
  if (raw.status !== "pending") throw new WriteError(`Approval sudah ${String(raw.status)}, tidak bisa diubah`, 409);

  // Semua field lain dipertahankan apa adanya; hanya 3 field ini yang berubah.
  const next = { ...raw, status, catatanBos, decidedAt: new Date().toISOString() };
  writeAtomic(file, JSON.stringify(next, null, 2));
  return next;
}

export function activateKillSwitch() {
  const file = officePath("execution", "STOP");
  if (exists(file)) return { alreadyActive: true };
  writeAtomic(file, `${new Date().toISOString()} — kill switch dari Trading Floor UI\n`);
  return { alreadyActive: false };
}
