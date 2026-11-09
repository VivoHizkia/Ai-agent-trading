// Client signed Binance USDT-M Futures — endpoint PRIVATE (order, akun, leverage). Beda dari src/data/binance.ts yang publik.
// Kredensial HANYA dari env (BINANCE_API_KEY / BINANCE_API_SECRET), tidak pernah di-hardcode atau di-log.
import { createHmac } from "node:crypto";

const BASE = process.env.BINANCE_FAPI ?? "https://fapi.binance.com";

function creds(): { apiKey: string; secret: string } {
  const apiKey = process.env.BINANCE_API_KEY;
  const secret = process.env.BINANCE_API_SECRET;
  if (!apiKey || !secret) throw new Error("BINANCE_API_KEY / BINANCE_API_SECRET belum di-set di environment.");
  return { apiKey, secret };
}

function sign(params: Record<string, string | number | boolean>, secret: string): string {
  const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
  const sig = createHmac("sha256", secret).update(qs).digest("hex");
  return `${qs}&signature=${sig}`;
}

const TIMEOUT_MS = 15_000;

/** Request terkirim tapi hasilnya tidak diketahui (timeout, koneksi putus, 5xx): order MUNGKIN sudah tereksekusi.
 * Beda dengan Error biasa (4xx) yang berarti Binance pasti menolak. */
export class BinanceUnknownResult extends Error {}

/** GET hanya membaca, jadi aman diulang saat koneksi putus/5xx (gangguan jaringan sesaat di PC ini cukup sering).
 * POST/DELETE TIDAK diulang: order yang dikirim dua kali bisa membuka posisi dobel. */
const GET_RETRY_DELAYS_MS = [1_000, 3_000];

// Jam laptop bisa melenceng dari jam Binance (30 Okt: +1,9 detik). Binance menolak timestamp yang lebih dari 1 detik
// di depan jam server (-1021), jadi SEMUA request bertanda tangan gagal. Timestamp memakai jam server Binance:
// selisihnya diukur ulang tiap 30 menit, dan langsung saat Binance menolak timestamp.
const TIME_SYNC_MS = 30 * 60_000;
let clockOffsetMs = 0;
let clockSyncedAt = 0;
async function syncClock(): Promise<void> {
  try {
    const t0 = Date.now();
    const res = await fetch(`${BASE}/fapi/v1/time`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const { serverTime } = (await res.json()) as { serverTime: number };
    if (Number.isFinite(serverTime)) clockOffsetMs = serverTime - (t0 + Date.now()) / 2;
    clockSyncedAt = Date.now();
  } catch { /* pakai selisih lama; dicoba lagi di request berikutnya */ }
}

async function signedRequest(method: "GET" | "POST" | "DELETE", path: string, params: Record<string, string | number | boolean> = {}): Promise<unknown> {
  if (Date.now() - clockSyncedAt > TIME_SYNC_MS) await syncClock();
  let resynced = false;
  for (let attempt = 0; ; attempt++) {
    try { return await signedRequestOnce(method, path, params); }
    catch (e) {
      // -1021 = timestamp ditolak: Binance PASTI tidak memproses request ini, jadi aman diulang (order juga) setelah sinkron.
      if (!resynced && /-1021/.test((e as Error).message)) { resynced = true; await syncClock(); continue; }
      const delay = GET_RETRY_DELAYS_MS[attempt];
      if (method !== "GET" || !(e instanceof BinanceUnknownResult) || delay === undefined) throw e;
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

async function signedRequestOnce(method: "GET" | "POST" | "DELETE", path: string, params: Record<string, string | number | boolean>): Promise<unknown> {
  const { apiKey, secret } = creds();
  const qs = sign({ ...params, timestamp: Math.round(Date.now() + clockOffsetMs), recvWindow: 10_000 }, secret);
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}?${qs}`, { method, headers: { "X-MBX-APIKEY": apiKey }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new BinanceUnknownResult(`Binance ${method} ${path}: tidak ada jawaban (${(e as Error).message})`);
  }
  const text = await res.text();
  if (res.status >= 500) throw new BinanceUnknownResult(`Binance ${res.status}: ${text.slice(0, 300)}`);
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new Error(`Binance ${res.status}: jawaban bukan JSON (${text.slice(0, 200)})`); }
  if (!res.ok) throw new Error(`Binance ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

export interface AccountInfo { totalWalletBalance: number; totalMarginBalance: number; availableBalance: number; totalUnrealizedProfit: number }

export async function getAccount(): Promise<AccountInfo> {
  const r = (await signedRequest("GET", "/fapi/v2/account")) as Record<string, string>;
  return {
    totalWalletBalance: Number(r.totalWalletBalance),
    totalMarginBalance: Number(r.totalMarginBalance),
    availableBalance: Number(r.availableBalance),
    totalUnrealizedProfit: Number(r.totalUnrealizedProfit ?? 0),
  };
}

export interface PositionRisk { symbol: string; positionAmt: number; entryPrice: number; leverage: number }

export async function getPositionRisk(symbol: string): Promise<PositionRisk | null> {
  const r = (await signedRequest("GET", "/fapi/v2/positionRisk", { symbol })) as Record<string, string>[];
  const p = r[0];
  if (!p || Number(p.positionAmt) === 0) return null;
  return { symbol, positionAmt: Number(p.positionAmt), entryPrice: Number(p.entryPrice), leverage: Number(p.leverage) };
}

/** Semua posisi terbuka di akun (satu panggilan, weight 5). Key = simbol. */
export async function getAllPositions(): Promise<Map<string, PositionRisk>> {
  const r = (await signedRequest("GET", "/fapi/v2/positionRisk")) as Record<string, string>[];
  const out = new Map<string, PositionRisk>();
  for (const p of r) {
    const amt = Number(p.positionAmt);
    if (amt !== 0) out.set(p.symbol!, { symbol: p.symbol!, positionAmt: amt, entryPrice: Number(p.entryPrice), leverage: Number(p.leverage) });
  }
  return out;
}

/** true = Hedge Mode. Bot ini hanya mendukung One-way Mode (order tanpa positionSide). */
export async function isHedgeMode(): Promise<boolean> {
  const r = (await signedRequest("GET", "/fapi/v1/positionSide/dual")) as { dualSidePosition?: boolean };
  return r.dualSidePosition === true;
}

export interface AlgoOrder { algoId: number; type: string; side: string; triggerPrice: number; status: string; closePosition: boolean }

/** Algo order (SL/TP) yang masih aktif untuk simbol ini. Melempar error kalau format jawaban tidak dikenal. */
export async function getOpenAlgoOrders(symbol: string): Promise<AlgoOrder[]> {
  const r = await signedRequest("GET", "/fapi/v1/openAlgoOrders", { symbol });
  if (!Array.isArray(r)) throw new Error(`format openAlgoOrders tidak dikenal: ${JSON.stringify(r).slice(0, 200)}`);
  return (r as Record<string, unknown>[]).map(o => ({
    algoId: Number(o.algoId), type: String(o.orderType ?? o.type ?? ""), side: String(o.side ?? ""),
    triggerPrice: Number(o.triggerPrice), status: String(o.algoStatus ?? ""), closePosition: String(o.closePosition) === "true",
  }));
}

export async function setLeverage(symbol: string, leverage: number): Promise<void> {
  await signedRequest("POST", "/fapi/v1/leverage", { symbol, leverage });
}

export interface LeverageBracket { initialLeverage: number; notionalCap: number; notionalFloor: number }

/** Batas leverage ASLI exchange per simbol (beda-beda tiap simbol & tier notional) — dibaca sebelum setLeverage. */
export async function getLeverageBrackets(symbol: string): Promise<LeverageBracket[]> {
  const r = (await signedRequest("GET", "/fapi/v1/leverageBracket", { symbol })) as { brackets: LeverageBracket[] }[];
  return r[0]?.brackets ?? [];
}

// Order biasa (/fapi/v1/order) cuma untuk MARKET. Sejak migrasi Binance 2025-11, STOP_MARKET/TAKE_PROFIT_MARKET
// di endpoint ini ditolak (-4120) dan WAJIB lewat Algo Order API — lihat placeProtectiveOrder di bawah.
export interface NewOrderParams {
  symbol: string;
  side: "BUY" | "SELL";
  type: "MARKET";
  quantity: number;
  reduceOnly?: boolean;
}

export async function newOrder(p: NewOrderParams): Promise<{ orderId: number; status: string }> {
  const params: Record<string, string | number | boolean> = { symbol: p.symbol, side: p.side, type: p.type, quantity: p.quantity };
  if (p.reduceOnly) params.reduceOnly = "true";
  return (await signedRequest("POST", "/fapi/v1/order", params)) as { orderId: number; status: string };
}

/** Stop loss / take profit yang menutup SELURUH posisi simbol saat harga mark menyentuh triggerPrice. Mengembalikan algoId. */
export async function placeProtectiveOrder(symbol: string, side: "BUY" | "SELL", type: "STOP_MARKET" | "TAKE_PROFIT_MARKET", triggerPrice: number): Promise<number> {
  const r = (await signedRequest("POST", "/fapi/v1/algoOrder", {
    algoType: "CONDITIONAL", symbol, side, type, triggerPrice, closePosition: "true", workingType: "MARK_PRICE",
  })) as { algoId: number };
  if (!Number.isFinite(r.algoId)) throw new Error(`Binance tidak mengembalikan algoId untuk ${type} ${symbol}: ${JSON.stringify(r)}`);
  return r.algoId;
}

export async function cancelAlgoOrder(algoId: number): Promise<void> {
  await signedRequest("DELETE", "/fapi/v1/algoOrder", { algoId });
}

export async function cancelAllAlgoOpenOrders(symbol: string): Promise<void> {
  await signedRequest("DELETE", "/fapi/v1/algoOpenOrders", { symbol });
}

/** Tutup posisi simbol ini dengan MARKET reduceOnly seukuran posisi ASLI di exchange. false = memang tidak ada posisi. */
export async function closePositionMarket(symbol: string): Promise<boolean> {
  const pos = await getPositionRisk(symbol);
  if (!pos) return false;
  await newOrder({ symbol, side: pos.positionAmt > 0 ? "SELL" : "BUY", type: "MARKET", quantity: Math.abs(pos.positionAmt), reduceOnly: true });
  return true;
}

export async function cancelAllOpenOrders(symbol: string): Promise<void> {
  await signedRequest("DELETE", "/fapi/v1/allOpenOrders", { symbol });
}

export async function cancelOrder(symbol: string, orderId: number): Promise<void> {
  await signedRequest("DELETE", "/fapi/v1/order", { symbol, orderId });
}

export interface UserTrade { side: "BUY" | "SELL"; price: number; qty: number; realizedPnl: number; commission: number; commissionAsset: string; time: number }

/** Riwayat fill akun untuk simbol ini sejak startTime (READ-ONLY). Dipakai jurnal trade. */
export async function getUserTrades(symbol: string, startTime: number): Promise<UserTrade[]> {
  const r = (await signedRequest("GET", "/fapi/v1/userTrades", { symbol, startTime, limit: 1000 })) as Record<string, string | number>[];
  return r.map(t => ({
    side: t.side as "BUY" | "SELL", price: Number(t.price), qty: Number(t.qty), realizedPnl: Number(t.realizedPnl),
    commission: Number(t.commission), commissionAsset: String(t.commissionAsset), time: Number(t.time),
  }));
}

/** Riwayat income (funding, dll.) sejak startTime (READ-ONLY). */
export async function getIncome(symbol: string, startTime: number, incomeType?: string): Promise<{ incomeType: string; income: number; time: number }[]> {
  const params: Record<string, string | number> = { symbol, startTime, limit: 1000 };
  if (incomeType) params.incomeType = incomeType;
  const r = (await signedRequest("GET", "/fapi/v1/income", params)) as Record<string, string | number>[];
  return r.map(i => ({ incomeType: String(i.incomeType), income: Number(i.income), time: Number(i.time) }));
}

/** Income semua simbol sejak startTime (READ-ONLY), dengan paginasi. Dipakai hitung PnL harian tanpa terganggu deposit/withdraw. */
export async function getIncomeAll(startTime: number): Promise<{ incomeType: string; income: number; time: number; asset?: string; tranId?: string }[]> {
  const out: { incomeType: string; income: number; time: number; asset?: string; tranId?: string }[] = [];
  let cursor = startTime;
  for (let page = 0; page < 10; page++) {
    const r = (await signedRequest("GET", "/fapi/v1/income", { startTime: cursor, limit: 1000 })) as Record<string, string | number>[];
    out.push(...r.map(i => ({ incomeType: String(i.incomeType), income: Number(i.income), time: Number(i.time), asset: i.asset != null ? String(i.asset) : undefined, tranId: i.tranId != null ? String(i.tranId) : undefined })));
    if (r.length < 1000) break;
    cursor = Number(r[r.length - 1]!.time) + 1;
  }
  return out;
}

export async function getOpenOrders(symbol: string): Promise<{ orderId: number; type: string; stopPrice: string }[]> {
  return (await signedRequest("GET", "/fapi/v1/openOrders", { symbol })) as { orderId: number; type: string; stopPrice: string }[];
}
