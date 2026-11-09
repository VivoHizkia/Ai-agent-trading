import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// OFFICE_DIR diarahkan ke folder sementara SEBELUM modul diimpor, supaya /stop_ya di tes tidak pernah
// membuat file STOP di office/ asli (yang akan menghentikan bot live).
let dir: string;
let mod: typeof import("../src/agents/tg-commands.js");

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-office-"));
  process.env.OFFICE_DIR = dir;
  vi.resetModules();
  mod = await import("../src/agents/tg-commands.js");
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.OFFICE_DIR;
});

const stopFile = () => path.join(dir, "execution", "STOP");

describe("perintah Telegram", () => {
  it("/help menyebut semua perintah", async () => {
    const r = await mod.handleCommand("/help");
    for (const c of mod.COMMANDS) expect(r).toContain(`/${c.cmd}`);
  });

  it("nama bot di belakang perintah diabaikan (/status@MyBot)", async () => {
    expect(await mod.handleCommand("/status@MyBot")).toContain("Status bot");
  });

  it("perintah tidak dikenal dan teks biasa dijawab dengan petunjuk", async () => {
    expect(await mod.handleCommand("/beli BTC")).toContain("/help");
    expect(await mod.handleCommand("halo")).toContain("/help");
  });

  it("/posisi tanpa state: tidak ada posisi", async () => {
    expect(await mod.handleCommand("/posisi")).toContain("Tidak ada posisi");
  });

  it("/stop_ya tanpa /stop sebelumnya TIDAK membuat kill switch", async () => {
    expect(await mod.handleCommand("/stop_ya", 1_000_000)).toContain("Kirim /stop dulu");
    expect(fs.existsSync(stopFile())).toBe(false);
  });

  it("konfirmasi kedaluwarsa setelah 60 detik", async () => {
    await mod.handleCommand("/stop", 2_000_000);
    expect(await mod.handleCommand("/stop_ya", 2_000_000 + 61_000)).toContain("Kirim /stop dulu");
    expect(fs.existsSync(stopFile())).toBe(false);
  });

  it("/stop lalu /stop_ya dalam 60 detik membuat file STOP", async () => {
    await mod.handleCommand("/stop", 3_000_000);
    expect(await mod.handleCommand("/stop_ya", 3_000_000 + 10_000)).toContain("Kill switch aktif");
    expect(fs.readFileSync(stopFile(), "utf8")).toContain("Telegram");
  });

  it("konfirmasi hanya berlaku sekali", async () => {
    expect(await mod.handleCommand("/stop_ya", 3_000_000 + 20_000)).toContain("Kirim /stop dulu");
  });
});
