import "server-only";
import fs from "node:fs";
import path from "node:path";
import type { z } from "zod";

// Semua akses filesystem ke office/ lewat modul ini. Path selalu disusun dengan path.join/resolve
// (Windows), dan setiap path dicek tetap di dalam OFFICE_DIR.

export const OFFICE_DIR = path.resolve(process.cwd(), process.env.OFFICE_DIR ?? path.join("..", "trading-floor-engine", "office"));
export const ENGINE_DATA_DIR = path.resolve(process.cwd(), process.env.ENGINE_DATA_DIR ?? path.join("..", "trading-floor-engine", "data"));

/** Batas ukuran file JSON biasa yang mau di-parse. scan-*.json (40MB+) tidak pernah lewat sini. */
const MAX_JSON_BYTES = 2 * 1024 * 1024;

export function officePath(...parts: string[]): string {
  for (const p of parts) {
    if (p.includes("..") || path.isAbsolute(p)) throw new Error(`Path tidak sah: ${p}`);
  }
  const full = path.resolve(OFFICE_DIR, ...parts);
  const rel = path.relative(OFFICE_DIR, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`Path keluar dari OFFICE_DIR: ${full}`);
  return full;
}

export function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export function statSafe(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

export function listDir(p: string, filter?: (name: string) => boolean): string[] {
  try {
    const names = fs.readdirSync(p);
    return filter ? names.filter(filter) : names;
  } catch {
    return [];
  }
}

export function readText(p: string, maxBytes = 512 * 1024): { text: string; truncated: boolean } | null {
  const st = statSafe(p);
  if (!st || !st.isFile()) return null;
  try {
    if (st.size <= maxBytes) return { text: fs.readFileSync(p, "utf8"), truncated: false };
    // File terlalu besar: ambil bagian akhirnya saja (catatan terbaru biasanya di bawah).
    const fd = fs.openSync(p, "r");
    try {
      const buf = Buffer.alloc(maxBytes);
      fs.readSync(fd, buf, 0, maxBytes, st.size - maxBytes);
      const text = buf.toString("utf8");
      return { text: text.slice(text.indexOf("\n") + 1), truncated: true };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** Baca n byte pertama saja (untuk cek header file besar). */
export function readHead(p: string, n = 2048): string | null {
  try {
    const fd = fs.openSync(p, "r");
    try {
      const buf = Buffer.alloc(n);
      const got = fs.readSync(fd, buf, 0, n, 0);
      return buf.subarray(0, got).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** Baca + validasi JSON. File rusak/tidak cocok skema → null + dicatat di log server, tidak pernah throw. */
export function readJson<T extends z.ZodType>(p: string, schema: T): z.infer<T> | null {
  const st = statSafe(p);
  if (!st || !st.isFile()) return null;
  if (st.size > MAX_JSON_BYTES) {
    console.warn(`[office] dilewati, terlalu besar (${st.size} byte): ${p}`);
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    console.warn(`[office] JSON rusak, dilewati: ${p} — ${(e as Error).message}`);
    return null;
  }
  const res = schema.safeParse(raw);
  if (!res.success) {
    console.warn(`[office] skema tidak cocok, dilewati: ${p} — ${res.error.issues[0]?.message ?? "?"}`);
    return null;
  }
  return res.data;
}

/** Tulis atomik: .tmp lalu rename. Hanya dipakai untuk file yang diizinkan (lihat approvals.ts & killswitch.ts). */
export function writeAtomic(p: string, content: string) {
  const rel = path.relative(OFFICE_DIR, p);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("Menolak menulis di luar OFFICE_DIR");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, p);
}
