// Bentuk snapshot yang dikirim server → klien. Hanya tipe, aman untuk klien.
import type { AgentSlug, AgentState } from "./roster";

export interface AgentView {
  slug: AgentSlug;
  state: AgentState;
  bubble: string;
  updatedAt: string | null;
  /** "status.json" kalau ditulis engine/agent, "turunan" kalau disimpulkan dari data lain. */
  source: "status.json" | "turunan" | "default";
}

export interface MessageView {
  key: string;
  from: string;
  to: string;
  fromName: string;
  toName: string;
  subject: string;
  body: string;
  createdAt: string;
  read: boolean;
}

export interface ApprovalView {
  id: string;
  createdAt: string;
  symbol: string;
  tf: string;
  strategyId: string;
  side: "long" | "short";
  qty: number | null;
  stop: number | null;
  target: number | null;
  leverage: number | null;
  riskUsd: number | null;
  reason: string;
  status: "pending" | "approved" | "rejected" | "expired";
  catatanBos: string;
  decidedAt: string | null;
}

export interface PositionView {
  key: string;
  symbol: string;
  tf: string;
  strategyId: string;
  side: "long" | "short";
  entry: number;
  qty: number;
  stop: number;
  target: number | null;
  leverage: number;
  riskUsd: number;
  notional: number;
  entryTime: number;
}

export interface ScanRowView {
  rank: number;
  symbol: string;
  tf: string;
  strategy: string;
  trades: number | null;
  winPct: string;
  pf: string;
  returnPct: number | null;
  expR: number | null;
  maxDd: string;
  holdPct: number | null;
  vonis: string;
}

export interface ScanView {
  file: string;
  createdAt: string | null;
  title: string;
  synthetic: boolean;
  total: number;
  kandidat: number;
  top: ScanRowView[];
}

export interface DebateView {
  file: string;
  createdAt: string;
  goPaper: number;
  watch: number;
  reject: number;
  top: { symbol: string; tf: string; strategyId: string; verdict: string; confidence: string }[];
}

export interface LogLineView {
  t: string;
  msg: string;
}

export interface WatchItem {
  symbol: string;
  tf: string;
  strategyId: string;
  /** Risk per trade khusus baris ini (%), kalau diatur di watchlist.json. */
  riskPct?: number;
}

export interface RiskRuleView {
  aturan: string;
  nilai: string;
}

export interface PriceView {
  symbol: string;
  last: number;
  chgPct: number | null;
  fundingPct: number | null;
  source: "binance" | "snapshot" | "data";
}

export interface ExecutionView {
  mode: "DRY_RUN" | "LIVE" | "TIDAK DIKETAHUI";
  modeSince: string | null;
  autoEntry: boolean;
  killSwitch: boolean;
  killSwitchAt: string | null;
  positions: PositionView[];
  exposurePct: number | null;
  rejectedToday: number;
  lastLog: LogLineView[];
  /** Log terakhir khusus strategi 1h (Ruang Scalping). */
  log1h: LogLineView[];
  watchlist: WatchItem[];
  watchlistDraft: WatchItem[];
  lastTickAt: string | null;
}

export interface EquityView {
  mode: string;
  last: number;
  lastAt: string;
  dayStart: number | null;
  dayChange: number | null;
  dayChangePct: number | null;
  /** Titik equity 7 hari terakhir, maksimal 240 titik. */
  points: { t: string; equity: number }[];
  /** Perubahan equity per hari WIB, 14 hari terakhir. */
  daily: { day: string; pnl: number }[];
  count: number;
  /** Total deposit (+) / penarikan (−) sejak titik pertama; sudah dikeluarkan dari perhitungan untung/rugi. */
  netTransfers: number;
  /** Batas rugi harian di-reset Bos hari ini (execution/DAY_RESET): meteran dihitung dari saat reset. */
  dayReset: { at: string; start: number; change: number; changePct: number } | null;
}

export interface TradeView {
  key: string;
  t: string;
  mode: string;
  symbol: string;
  tf: string;
  strategyId: string;
  side: "long" | "short";
  entry: number;
  exit: number;
  pnl: number;
  r: number;
  fees: number;
  funding: number;
  reason: string;
  source: string;
  holdHours: number | null;
  crowd: string | null;
}

export interface StrategyJournal {
  symbol: string;
  tf: string;
  strategyId: string;
  n: number;
  winRate: number;
  avgR: number;
  pnl: number;
  bt: { winPct: number | null; expR: number | null; trades: number | null; vonis: string; file: string } | null;
  status: "sampel kecil" | "sesuai backtest" | "di bawah backtest" | "di atas backtest" | "tanpa data backtest";
}

export interface JournalView {
  mode: string;
  total: number;
  wins: number;
  winRate: number;
  avgR: number;
  totalPnl: number;
  lastAt: string;
  recent: TradeView[];
  byStrategy: StrategyJournal[];
}

export interface OpsView {
  bot: { status: "hidup" | "tidak merespons" | "belum pernah jalan" | "dihentikan"; lastBeat: string | null; ageMin: number | null };
  notifier: { status: "hidup" | "mati" | "belum pernah jalan"; lastBeat: string | null; ageMin: number | null };
  errorsToday: number;
  lastErrors: { t: string; msg: string }[];
  lastLogAt: string | null;
  calendarAt: string | null;
  regimeAt: string | null;
  labAt: string | null;
  reviewAt: string | null;
}

export interface RegimeRowView { symbol: string; regime: string; label: string; close: number; adx: number; atrPct: number; atrPctile: number; chg24h: number }
export interface RegimeView {
  updatedAt: string;
  rows: RegimeRowView[];
  fits: { symbol: string; tf: string; strategyId: string; regime: string; fit: "cocok" | "kurang cocok" | "netral"; note: string }[];
}

export interface CrowdRowView { symbol: string; funding: number | null; oiChg24h: number | null; lsRatio: number | null; takerRatio: number | null; flag: "long ramai" | "short ramai" | "normal"; note: string }
export interface CrowdView { updatedAt: string; fearGreed: { value: number; label: string; prev: number | null } | null; rows: CrowdRowView[] }

export interface ScalpRowView {
  symbol: string; tf: string; strategyId: string; strategyName: string;
  targetPct: number; stopPct: number; roeTarget: number; roeStop: number;
  trades: number; perDay: number; winRate: number; avgR: number; grossR: number; feeR: number;
  pf: number; returnPct: number; maxDD: number; level: string; label: string;
}
export interface ScalpGroupView { key: string; n: number; positive: number; kandidat: number; avgR: number; grossR: number; winRate: number; perDay: number }
export interface ScalpView {
  file: string; createdAt: string; symbols: string[]; tfs: string[]; leverageForRoe: number;
  total: number; kandidat: number; positive: number;
  top: ScalpRowView[]; byTarget: ScalpGroupView[]; byStrategy: ScalpGroupView[]; byTf: ScalpGroupView[];
}

/** Satu uji riset di office/scalp (scalping 5m/15m atau sinyal 4h + entry 15m). */
export interface ScalpHistoryItem { createdAt: string; kind: "scalp" | "mtf" | "scan1h"; label: string; result: string; good: boolean }

export interface CalendarEventView { title: string; country: string; impact: string; at: string; forecast: string; previous: string }
export interface CalendarView {
  updatedAt: string;
  source: string;
  events: CalendarEventView[];
  nextHigh: CalendarEventView | null;
  /** Berita high-impact dalam ±30 menit dari sekarang. */
  nearHigh: CalendarEventView | null;
}

export interface LabRowView {
  symbol: string; tf: string; strategyId: string; strategyName: string;
  full: { trades: number; winRate: number; avgR: number; returnPct: number; maxDD: number; pf: number };
  recent: { days: number; trades: number; winRate: number; avgR: number };
  verdict: string;
  status: string;
  note: string;
}
export interface LabView { file: string; createdAt: string; from: string; recentDays: number; rows: LabRowView[] }

export interface ReviewView {
  week: string;
  mode: string;
  createdAt: string;
  trades: { n: number; winRate: number; avgR: number; pnl: number };
  prev: { n: number; winRate: number; avgR: number; pnl: number };
  equity: { change: number | null; changePct: number | null; worstDay: { day: string; pnl: number } | null };
  entries: number;
  rejected: number;
  errors: number;
  byStrategy: { key: string; n: number; winRate: number; avgR: number; pnl: number }[];
  notes: string[];
  markdownFile: string | null;
}

export interface AccountView {
  equity: number;
  equitySource: string;
  riskPerTradePct: number;
  dailyLossPct: number;
  maxPositions: number;
  maxLeverage: number;
}

export interface Snapshot {
  generatedAt: string;
  officeDir: string;
  officeOk: boolean;
  officeEmpty: boolean;
  agents: AgentView[];
  messages: MessageView[];
  approvals: ApprovalView[];
  execution: ExecutionView;
  scan: ScanView | null;
  debate: DebateView | null;
  marketSnapshot: { updatedAt: string | null; rows: { symbol: string; markPrice: number | null; fundingRatePct: number | null }[] };
  riskRules: RiskRuleView[];
  account: AccountView;
  equity: EquityView | null;
  journal: JournalView | null;
  ops: OpsView;
  regime: RegimeView | null;
  crowd: CrowdView | null;
  scalp: ScalpView | null;
  scalpHistory: ScalpHistoryItem[];
  calendar: CalendarView | null;
  lab: LabView | null;
  review: ReviewView | null;
  warnings: string[];
}

export interface AgentDetail {
  notes: string;
  notesFile: string | null;
  notesTruncated: boolean;
  messages: MessageView[];
}
