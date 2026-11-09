import { z } from "zod";
import { STATES } from "../roster";

// Skema longgar: field yang dipakai UI divalidasi, field lain dibiarkan (looseObject) supaya
// perubahan kecil di engine tidak membuat UI menolak file.

export const AgentStatusSchema = z.looseObject({
  id: z.string().optional(),
  nama: z.string().optional(),
  state: z.enum(STATES).catch("working"),
  bubble: z.string().default(""),
  updatedAt: z.string().optional(),
});

export const InboxMessageSchema = z.looseObject({
  from: z.string(),
  to: z.string(),
  subject: z.string().default(""),
  body: z.string().default(""),
  createdAt: z.string(),
  read: z.boolean().default(false),
});

const num = z.number().finite();

// Skema approval asli dari trading-floor-engine/src/exec/approvals.ts (dibuat bot.ts).
export const ApprovalSchema = z.looseObject({
  id: z.string(),
  createdAt: z.string(),
  symbol: z.string(),
  tf: z.string().default(""),
  strategyId: z.string().default(""),
  side: z.enum(["long", "short"]),
  qty: num.optional(),
  stop: num.optional(),
  target: num.optional(),
  leverage: num.optional(),
  riskUsd: num.optional(),
  reason: z.string().default(""),
  status: z.enum(["pending", "approved", "rejected", "expired"]),
  catatanBos: z.string().optional(),
  decidedAt: z.string().optional(),
});

export const BotPositionSchema = z.looseObject({
  side: z.enum(["long", "short"]),
  entry: num,
  qty: num,
  stop: num,
  target: num.optional(),
  leverage: num,
  entryTime: num,
  riskUsd: num,
});

export const BotStateSchema = z.record(
  z.string(),
  z.looseObject({
    position: BotPositionSchema.nullable().catch(null),
    lastBarTime: num.optional(),
    dayKey: num.optional(),
    dayStartEquity: num.optional(),
  }),
);

export const WatchlistSchema = z.array(
  z.looseObject({ symbol: z.string(), tf: z.string(), strategyId: z.string(), riskPct: z.number().finite().positive().optional().catch(undefined) }),
);

export const MarketSnapshotSchema = z.looseObject({
  updatedAt: z.string().nullable().optional(),
  rows: z.array(
    z.looseObject({
      symbol: z.string(),
      markPrice: num.optional(),
      fundingRatePct: num.optional(),
    }),
  ),
});

export const DebateFileSchema = z.looseObject({
  createdAt: z.string(),
  results: z.array(
    z.looseObject({
      symbol: z.string(),
      tf: z.string(),
      strategyId: z.string(),
      verdict: z.enum(["go_paper", "watch", "reject"]),
      confidence: z.string().default("low"),
    }),
  ),
});

export const EquityLineSchema = z.object({ t: z.string(), equity: z.number().finite(), mode: z.string().optional() });

export const TradeLineSchema = z.looseObject({
  t: z.string(),
  mode: z.string().default("?"),
  symbol: z.string(),
  tf: z.string(),
  strategyId: z.string(),
  side: z.enum(["long", "short"]),
  entry: z.number().finite(),
  exit: z.number().finite(),
  pnl: z.number().finite(),
  r: z.number().finite(),
  fees: z.number().finite().default(0),
  funding: z.number().finite().default(0),
  reason: z.string().default(""),
  source: z.string().default(""),
  openedAt: z.number().finite().optional(),
  closedAt: z.number().finite().optional(),
  crowd: z.string().nullish(),
});

export const LogLineSchema = z.object({ t: z.string(), msg: z.string() });

// Body POST dari browser.
export const DecideBodySchema = z.object({
  status: z.enum(["approved", "rejected"]),
  catatanBos: z.string().trim().max(500).default(""),
});

export const KillSwitchBodySchema = z.object({
  konfirmasi: z.literal("STOP"),
});
