import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkStatus, createApproval, decide, listPending, readApproval, waitForDecision } from "../src/exec/approvals.js";
import { OFFICE_DIR } from "../src/report/office.js";

const base = { symbol: "TESTUSDT", tf: "4h", strategyId: "test_strategy", side: "long" as const, qty: 1, stop: 90, leverage: 1, riskUsd: 10, reason: "unit test" };
const created: string[] = [];

function make() {
  const req = createApproval(base);
  created.push(req.id);
  return req;
}

afterEach(() => {
  for (const id of created) fs.rmSync(path.join(OFFICE_DIR, "approvals", `${id}.json`), { force: true });
  created.length = 0;
});

describe("approval queue", () => {
  it("dibuat dengan status pending", () => {
    const req = make();
    expect(req.status).toBe("pending");
    expect(readApproval(req.id)?.status).toBe("pending");
  });

  it("muncul di listPending sampai diputuskan", () => {
    const req = make();
    expect(listPending().some(r => r.id === req.id)).toBe(true);
    decide(req.id, "approved");
    expect(listPending().some(r => r.id === req.id)).toBe(false);
  });

  it("decide('approved') diteruskan waitForDecision", async () => {
    const req = make();
    decide(req.id, "approved");
    const outcome = await waitForDecision(req.id, 60_000, 10);
    expect(outcome).toBe("approved");
  });

  it("decide('rejected') diteruskan waitForDecision", async () => {
    const req = make();
    decide(req.id, "rejected");
    expect(await waitForDecision(req.id, 60_000, 10)).toBe("rejected");
  });

  it("auto-expired kalau lewat timeout tanpa keputusan", async () => {
    const req = make();
    const outcome = await waitForDecision(req.id, 20, 10);
    expect(outcome).toBe("expired");
    expect(readApproval(req.id)?.status).toBe("expired");
  });

  it("decide() yang sudah diputuskan tidak bisa ditimpa", () => {
    const req = make();
    decide(req.id, "approved");
    const second = decide(req.id, "rejected");
    expect(second.status).toBe("approved");
  });

  it("checkStatus tidak blocking: pending tetap pending kalau belum lewat timeout", () => {
    const req = make();
    expect(checkStatus(req.id, 60_000)).toBe("pending");
    expect(readApproval(req.id)?.status).toBe("pending");
  });

  it("checkStatus langsung lihat approved tanpa nunggu", () => {
    const req = make();
    decide(req.id, "approved");
    expect(checkStatus(req.id, 60_000)).toBe("approved");
  });

  it("checkStatus auto-expire kalau sudah lewat timeout sejak createdAt", async () => {
    const req = make();
    await new Promise(r => setTimeout(r, 15));
    expect(checkStatus(req.id, 10)).toBe("expired");
    expect(readApproval(req.id)?.status).toBe("expired");
  });
});
