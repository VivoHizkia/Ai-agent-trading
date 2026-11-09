import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BinanceUnknownResult, closePositionMarket, getAllPositions, getIncomeAll, getOpenAlgoOrders, newOrder, placeProtectiveOrder } from "../src/exec/binance-trade.js";

// fetch di-mock: tes ini tidak pernah menghubungi Binance, cuma memeriksa request yang AKAN dikirim.
type Call = { method: string; path: string; params: URLSearchParams };
let calls: Call[];
let responses: unknown[];
let timeCalls: number;
let serverAheadMs = 0; // jam server Binance di tes = jam laptop + serverAheadMs

beforeEach(() => {
  calls = [];
  responses = [];
  timeCalls = 0;
  process.env.BINANCE_API_KEY = "test-key";
  process.env.BINANCE_API_SECRET = "test-secret";
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: { method: string }) => {
    const u = new URL(url);
    // Jam server dijawab terpisah: tidak dicatat sebagai request dan tidak memakai antrean jawaban.
    if (u.pathname === "/fapi/v1/time") { timeCalls++; return { ok: true, status: 200, json: async () => ({ serverTime: Date.now() + serverAheadMs }) }; }
    calls.push({ method: init.method, path: u.pathname, params: u.searchParams });
    const r = responses.shift() ?? {};
    // { __throw } = koneksi putus/timeout, { __status, body } = jawaban error dari Binance.
    if (r && typeof r === "object" && "__throw" in r) throw new Error("network down");
    const status = r && typeof r === "object" && "__status" in r ? (r as { __status: number }).__status : 200;
    const body = status === 200 ? r : (r as { body?: unknown }).body ?? {};
    return { ok: status < 400, status, text: async () => JSON.stringify(body) };
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("binance-trade", () => {
  it("stop loss lewat Algo Order API, bukan /fapi/v1/order (yang menolak -4120)", async () => {
    responses.push({ algoId: 123 });
    const id = await placeProtectiveOrder("ARBUSDT", "BUY", "STOP_MARKET", 0.1812);
    expect(id).toBe(123);
    const c = calls[0]!;
    expect(c.method).toBe("POST");
    expect(c.path).toBe("/fapi/v1/algoOrder");
    expect(c.params.get("algoType")).toBe("CONDITIONAL");
    expect(c.params.get("type")).toBe("STOP_MARKET");
    expect(c.params.get("triggerPrice")).toBe("0.1812");
    expect(c.params.get("closePosition")).toBe("true");
    expect(c.params.has("stopPrice")).toBe(false);
    expect(c.params.has("quantity")).toBe(false);
  });

  it("respons tanpa algoId dianggap gagal (supaya posisi tidak dianggap terlindungi)", async () => {
    responses.push({});
    await expect(placeProtectiveOrder("ARBUSDT", "BUY", "STOP_MARKET", 0.18)).rejects.toThrow(/algoId/);
  });

  it("tutup posisi short: MARKET BUY reduceOnly seukuran posisi asli, tanpa closePosition (yang menolak -4136)", async () => {
    responses.push([{ positionAmt: "-189.7", entryPrice: "0.16569", leverage: "2" }], { orderId: 9 });
    expect(await closePositionMarket("ARBUSDT")).toBe(true);
    const order = calls[1]!;
    expect(order.path).toBe("/fapi/v1/order");
    expect(order.params.get("type")).toBe("MARKET");
    expect(order.params.get("side")).toBe("BUY");
    expect(order.params.get("quantity")).toBe("189.7");
    expect(order.params.get("reduceOnly")).toBe("true");
    expect(order.params.has("closePosition")).toBe(false);
  });

  it("tutup posisi long: SELL", async () => {
    responses.push([{ positionAmt: "5", entryPrice: "1", leverage: "3" }], { orderId: 9 });
    await closePositionMarket("ADAUSDT");
    expect(calls[1]!.params.get("side")).toBe("SELL");
  });

  it("tidak ada posisi: tidak mengirim order", async () => {
    responses.push([{ positionAmt: "0", entryPrice: "0", leverage: "1" }]);
    expect(await closePositionMarket("ADAUSDT")).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("entry MARKET biasa tetap ke /fapi/v1/order", async () => {
    responses.push({ orderId: 1, status: "FILLED" });
    await newOrder({ symbol: "ZECUSDT", side: "SELL", type: "MARKET", quantity: 0.085 });
    expect(calls[0]!.path).toBe("/fapi/v1/order");
    expect(calls[0]!.params.has("reduceOnly")).toBe(false);
  });

  it("koneksi putus saat order = BinanceUnknownResult (order mungkin sudah terisi)", async () => {
    responses.push({ __throw: true });
    await expect(newOrder({ symbol: "ZECUSDT", side: "BUY", type: "MARKET", quantity: 1 })).rejects.toBeInstanceOf(BinanceUnknownResult);
  });

  it("5xx = BinanceUnknownResult, 4xx = penolakan pasti (Error biasa)", async () => {
    responses.push({ __status: 503, body: { msg: "busy" } });
    await expect(newOrder({ symbol: "ZECUSDT", side: "BUY", type: "MARKET", quantity: 1 })).rejects.toBeInstanceOf(BinanceUnknownResult);
    responses.push({ __status: 400, body: { code: -2019, msg: "Margin is insufficient." } });
    const err = await newOrder({ symbol: "ZECUSDT", side: "BUY", type: "MARKET", quantity: 1 }).catch(e => e);
    expect(err).not.toBeInstanceOf(BinanceUnknownResult);
    expect(String(err.message)).toContain("-2019");
  });

  it("openAlgoOrders: membaca orderType/side dari jawaban Binance", async () => {
    responses.push([{ algoId: 5, orderType: "STOP_MARKET", side: "SELL", triggerPrice: "0.5", algoStatus: "NEW", closePosition: true }]);
    const o = await getOpenAlgoOrders("ADAUSDT");
    expect(calls[0]!.path).toBe("/fapi/v1/openAlgoOrders");
    expect(o[0]).toMatchObject({ algoId: 5, type: "STOP_MARKET", side: "SELL", triggerPrice: 0.5, closePosition: true });
  });

  it("openAlgoOrders: format tak dikenal melempar error (jangan dianggap 'stop hilang')", async () => {
    responses.push({ orders: [] });
    await expect(getOpenAlgoOrders("ADAUSDT")).rejects.toThrow(/format/);
  });

  it("getAllPositions hanya mengembalikan posisi yang tidak nol", async () => {
    responses.push([{ symbol: "ADAUSDT", positionAmt: "0", entryPrice: "0", leverage: "5" }, { symbol: "ZECUSDT", positionAmt: "-0.2", entryPrice: "300", leverage: "8" }]);
    const m = await getAllPositions();
    expect([...m.keys()]).toEqual(["ZECUSDT"]);
    expect(m.get("ZECUSDT")!.positionAmt).toBe(-0.2);
  });

  it("getIncomeAll paginasi sampai halaman tidak penuh", async () => {
    const page = Array.from({ length: 1000 }, (_, i) => ({ incomeType: "REALIZED_PNL", income: "0.01", time: 1000 + i }));
    responses.push(page, [{ incomeType: "TRANSFER", income: "70", time: 5000 }]);
    const all = await getIncomeAll(1000);
    expect(all).toHaveLength(1001);
    expect(calls[1]!.params.get("startTime")).toBe("2000");
  });

  it("GET (baca saja) diulang otomatis setelah koneksi putus", async () => {
    responses.push({ __throw: true }, [{ symbol: "ZECUSDT", positionAmt: "1", entryPrice: "300", leverage: "5" }]);
    const m = await getAllPositions();
    expect(calls).toHaveLength(2);
    expect(m.get("ZECUSDT")!.positionAmt).toBe(1);
  });

  it("order (POST) TIDAK diulang setelah koneksi putus: bisa dobel posisi", async () => {
    responses.push({ __throw: true }, { orderId: 2 });
    await expect(newOrder({ symbol: "ZECUSDT", side: "BUY", type: "MARKET", quantity: 1 })).rejects.toBeInstanceOf(BinanceUnknownResult);
    expect(calls).toHaveLength(1);
  });

  it("timestamp memakai jam server Binance, bukan jam laptop (30 Okt: laptop +1,9 detik ditolak -1021)", async () => {
    serverAheadMs = -5_000; // laptop 5 detik lebih cepat dari Binance
    responses.push({ __status: 400, body: { code: -1021, msg: "Timestamp for this request was 1000ms ahead of the server's time." } }, { orderId: 7 });
    const before = Date.now();
    await newOrder({ symbol: "ZECUSDT", side: "BUY", type: "MARKET", quantity: 1 });
    expect(timeCalls).toBeGreaterThanOrEqual(1);
    const ts = Number(calls.at(-1)!.params.get("timestamp"));
    expect(ts).toBeLessThan(before - 4_000);
    serverAheadMs = 0;
  });

  it("order yang ditolak karena timestamp (-1021) dikirim ulang SEKALI setelah sinkron jam", async () => {
    responses.push({ __status: 400, body: { code: -1021, msg: "Timestamp ahead" } }, { orderId: 8 });
    expect((await newOrder({ symbol: "ZECUSDT", side: "BUY", type: "MARKET", quantity: 1 })).orderId).toBe(8);
    expect(calls).toHaveLength(2);
    responses.push({ __status: 400, body: { code: -1021 } }, { __status: 400, body: { code: -1021 } }, { orderId: 9 });
    calls.length = 0;
    await expect(newOrder({ symbol: "ZECUSDT", side: "BUY", type: "MARKET", quantity: 1 })).rejects.toThrow(/-1021/);
    expect(calls).toHaveLength(2);
  });
});
