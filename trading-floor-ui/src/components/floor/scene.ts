// Renderer kantor isometrik bergaya pixel art.
// Dunia digambar di canvas resolusi rendah lalu diperbesar tanpa smoothing (pixelated),
// sedangkan teks (name tag, bubble status, label ruang) digambar di canvas overlay resolusi
// penuh supaya tetap tajam di zoom berapa pun. Logika grid, pintu, BFS, dan kamera sama
// dengan prototype/trading-floor.html.

import { ROSTER, type AgentSlug, type AgentState, type RoomId } from "@/lib/roster";

export interface SceneData {
  agents: { slug: AgentSlug; state: AgentState; bubble: string }[];
  pendingCount: number;
  prices: { symbol: string; last: number; chgPct: number | null }[];
  fundingBtc: number | null;
  equity: number;
  dailyLossPct: number;
  exposurePct: number | null;
  rejectedToday: number;
  positions: { symbol: string; side: "long" | "short"; tf?: string }[];
  mode: string;
  autoEntry: boolean;
  killSwitch: boolean;
  execStatus: string;
  boardTitle: string;
  board: { label: string; ret: number | null; hold: number | null }[];
  scanLine: string;
  eq: { last: number | null; change: number | null; changePct: number | null; series: number[]; daily: number[]; mode: string; floating: number | null };
  /** Pemakaian batas rugi harian 0..100+ (null = belum ada data equity). */
  lossUsed: number | null;
  journalLine: string;
  ops: { bot: string; notifier: string; errors: number; lastTick: string };
  regime: { rows: { symbol: string; label: string; regime: string }[]; fits: { key: string; fit: string }[] };
  news: { next: { title: string; at: string } | null; near: boolean; upcoming: { title: string; at: string; impact: string }[] };
  labRows: { key: string; status: string; recentR: number }[];
  reviewLines: string[];
  scalp: { lines: string[]; best: string; verdict: string } | null;
}

export type LightMode = "auto" | "malam" | "siang";
export type Who = AgentSlug | "bos";

interface Callbacks {
  onSelect: (who: Who) => void;
  onOpenApproval: () => void;
  onRoom: (room: RoomId) => void;
}

type P = { x: number; y: number };
type Cell = [number, number];
type Ctx = CanvasRenderingContext2D;

/** Di bawah zoom ini label disederhanakan supaya tidak bertumpuk saat melihat seluruh gedung. */
const FAR_ZOOM = 0.85;

interface Room { id: RoomId; name: string; x0: number; x1: number; y0: number; y1: number }
const ROOMS: Room[] = [
  { id: "lobby", name: "Lobby", x0: 0, x1: 8, y0: 0, y1: 7 },
  { id: "riset", name: "Ruang Riset", x0: 8, x1: 16, y0: 0, y1: 7 },
  { id: "risk", name: "Risk Desk", x0: 16, x1: 23, y0: 0, y1: 7 },
  { id: "exec", name: "Execution Room", x0: 23, x1: 30, y0: 0, y1: 7 },
  { id: "scalp", name: "Ruang Scalping", x0: 30, x1: 36, y0: 0, y1: 15 },
  { id: "meeting", name: "Ruang Meeting", x0: 0, x1: 8, y0: 7, y1: 15 },
  { id: "jurnal", name: "Ruang Jurnal", x0: 8, x1: 16, y0: 7, y1: 15 },
  { id: "lounge", name: "Lounge & Pool", x0: 16, x1: 23, y0: 7, y1: 15 },
  { id: "bos", name: "Ruang Bos", x0: 23, x1: 30, y0: 7, y1: 15 },
  { id: "ops", name: "Ruang Server", x0: 0, x1: 6, y0: 15, y1: 22 },
  { id: "regime", name: "Ruang Regime", x0: 6, x1: 12, y0: 15, y1: 22 },
  { id: "berita", name: "Meja Berita", x0: 12, x1: 18, y0: 15, y1: 22 },
  { id: "lab", name: "Lab R&D", x0: 18, x1: 24, y0: 15, y1: 22 },
  { id: "review", name: "Ruang Review", x0: 24, x1: 36, y0: 15, y1: 22 },
];
const GW = 36, GH = 22;
const TW = 64, TH = 32, WALL = 104;
const IDLE_SPOTS: Cell[] = [[17, 11], [18, 12], [22, 10], [22, 12], [17, 10], [20, 9]];
const MEETING_SEATS: Cell[] = [[2, 9], [5, 12], [5, 9], [2, 12], [3, 9], [4, 12], [4, 9], [3, 12]];

const iso = (gx: number, gy: number, z = 0): P => ({ x: (gx - gy) * TW / 2, y: (gx + gy) * TH / 2 - z });
const key = (x: number, y: number) => `${x},${y}`;
const roomOf = (gx: number, gy: number) => ROOMS.find(r => gx >= r.x0 && gx < r.x1 && gy >= r.y0 && gy < r.y1);
const rand = (i: number) => { const s = Math.sin(i * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
const fmt = (n: number, dp = 2) => Number(n).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
const priceDp = (n: number) => (n >= 1000 ? 1 : n >= 10 ? 2 : n >= 1 ? 3 : 5);
function shade(hex: string, f: number) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `rgb(${c((n >> 16) & 255)},${c((n >> 8) & 255)},${c(n & 255)})`;
}
const jktHour = () => Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jakarta", hour: "2-digit", hour12: false }).format(new Date())) % 24;

/* ================================================================== primitives (world space) */

function poly(ctx: Ctx, pts: P[], fill: string, stroke?: string) {
  ctx.beginPath(); ctx.moveTo(pts[0]!.x, pts[0]!.y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
  ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1.5; ctx.stroke(); }
}

interface BoxStyle { top?: string; left?: string; right?: string; outline?: string | false; alpha?: number }
/** Kotak isometrik dari (x0,y0) ke (x1,y1), tinggi h mulai dari z. */
function isoBox(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, z: number, h: number, color: string, s: BoxStyle = {}) {
  if (s.alpha != null) ctx.globalAlpha = s.alpha;
  const t = z + h;
  const N = iso(x0, y0, t), E = iso(x1, y0, t), S = iso(x1, y1, t), W = iso(x0, y1, t);
  const ol = s.outline === false ? undefined : s.outline ?? shade(color, 0.45);
  if (h > 0) {
    poly(ctx, [iso(x0, y1, z), iso(x1, y1, z), S, W], s.left ?? shade(color, 0.84), ol);
    poly(ctx, [iso(x1, y1, z), iso(x1, y0, z), E, S], s.right ?? shade(color, 0.68), ol);
  }
  poly(ctx, [N, E, S, W], s.top ?? color, ol);
  ctx.globalAlpha = 1;
}

/** Bidang miring untuk menggambar di permukaan yang menghadap +y (sejajar sumbu x). Satuan u: 1 grid = 32. */
function onFaceY(ctx: Ctx, x0: number, y: number, ztop: number, draw: () => void) {
  const o = iso(x0, y, ztop);
  ctx.save(); ctx.translate(o.x, o.y); ctx.transform(1, 0.5, 0, 1, 0, 0); draw(); ctx.restore();
}
/** Bidang miring untuk permukaan yang menghadap +x (sejajar sumbu y), dibaca kiri→kanan dari y1 ke y0. */
function onFaceX(ctx: Ctx, x: number, y1: number, ztop: number, draw: () => void) {
  const o = iso(x, y1, ztop);
  ctx.save(); ctx.translate(o.x, o.y); ctx.transform(1, -0.5, 0, 1, 0, 0); draw(); ctx.restore();
}

function px(ctx: Ctx, s: string, x: number, y: number, size: number, color: string, weight = 700) {
  ctx.font = `${weight} ${size}px "Pixelify Sans", "IBM Plex Mono", monospace`;
  ctx.fillStyle = color; ctx.fillText(s, x, y);
}

/* ================================================================== static world */

const blocked = new Set<string>();
const doors = new Set<string>();
function addDoor(a: Cell, b: Cell) { doors.add(key(...a) + "|" + key(...b)); doors.add(key(...b) + "|" + key(...a)); }
[8, 16, 23, 30].forEach(bx => { addDoor([bx - 1, 3], [bx, 3]); addDoor([bx - 1, 11], [bx, 11]); });
[4, 12, 19, 26].forEach(dx => addDoor([dx, 6], [dx, 7]));
// baris ruangan baru (y 15–22): pintu ke baris atas dan antar ruang
[3, 9, 14, 21, 27, 33].forEach(dx => addDoor([dx, 14], [dx, 15]));
[6, 12, 18, 24].forEach(bx => addDoor([bx - 1, 18], [bx, 18]));
function block(x0: number, y0: number, x1: number, y1: number) { for (let x = x0; x < x1; x++) for (let y = y0; y < y1; y++) blocked.add(key(x, y)); }

interface Drawable { depth: number; draw: (ctx: Ctx, t: number, s: FloorScene) => void }
const items: Drawable[] = [];
const glows: { gx: number; gy: number; z: number; r: number; c: string }[] = [];
const add = (depth: number, draw: Drawable["draw"]) => items.push({ depth, draw });

const WOOD = "#9b6b43", WOOD_D = "#6e4a2e", DESK = "#c99a66", METAL = "#3b4152", SCREEN = "#0f1626";

/* ---------- furniture builders */

function chart(ctx: Ctx, w: number, h: number, seed: number, t: number, color?: string) {
  ctx.fillStyle = SCREEN; ctx.fillRect(0, 0, w, h);
  const n = 7;
  for (let i = 0; i < n; i++) {
    const up = rand(seed + i + Math.floor(t / 2500)) > 0.42;
    const ch = 2 + rand(seed * 3 + i) * (h - 6);
    const x = 2 + i * (w - 4) / n;
    ctx.fillStyle = color ?? (up ? "#4fd18b" : "#ef6b57");
    ctx.fillRect(x, h - 2 - ch, Math.max(1.5, (w - 4) / n - 1.5), ch);
  }
}

/** Meja kerja dengan 1–3 monitor menghadap kursi di sisi +y. */
function workDesk(x: number, y: number, w: number, monitors: number, seed: number, glow = "#5fb7e6") {
  block(x, y, x + w, y + 1);
  add(x + w / 2 + y + 0.5, (ctx, t) => {
    // kaki
    for (const [lx, ly] of [[x + 0.08, y + 0.88], [x + w - 0.12, y + 0.88], [x + 0.08, y + 0.15], [x + w - 0.12, y + 0.15]] as const) isoBox(ctx, lx, ly, lx + 0.06, ly + 0.06, 0, 20, "#3a3f4f", { outline: false });
    isoBox(ctx, x, y + 0.1, x + w, y + 0.95, 20, 3, DESK);
    // monitor
    const mw = (w - 0.2) / monitors;
    for (let i = 0; i < monitors; i++) {
      const mx = x + 0.1 + i * mw;
      isoBox(ctx, mx + mw / 2 - 0.04, y + 0.3, mx + mw / 2 + 0.04, y + 0.36, 23, 6, METAL, { outline: false });
      isoBox(ctx, mx + 0.04, y + 0.22, mx + mw - 0.04, y + 0.3, 27, 16, "#1c2130");
      onFaceY(ctx, mx + 0.07, y + 0.3, 41.5, () => chart(ctx, (mw - 0.1) * 32, 13, seed + i * 7, t));
    }
    // keyboard + mug
    isoBox(ctx, x + w / 2 - 0.25, y + 0.55, x + w / 2 + 0.25, y + 0.72, 23, 1, "#e8e4da");
    isoBox(ctx, x + w - 0.3, y + 0.6, x + w - 0.2, y + 0.7, 23, 4, seed % 2 ? "#e06c5a" : "#f2f0ea");
    if (seed % 2) steam(ctx, iso(x + w - 0.25, y + 0.65, 27), t, seed);
  });
  glows.push({ gx: x + w / 2, gy: y + 0.3, z: 34, r: 26 + 14 * monitors, c: glow });
}

/** Uap tipis naik dari gelas kopi. */
function steam(ctx: Ctx, p: P, t: number, seed: number) {
  for (let i = 0; i < 3; i++) {
    const k = ((t / 1400 + i / 3 + seed * 0.13) % 1);
    ctx.globalAlpha = 0.45 * (1 - k);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(p.x + Math.sin(k * 6 + i) * 1.6 - 0.75, p.y - k * 12, 1.5, 2);
  }
  ctx.globalAlpha = 1;
}

/** Kursi kantor di petak (x,y), dudukan menghadap -y (ke meja). Tidak memblokir petak. */
function officeChair(x: number, y: number, color = "#2d3240") {
  const cx = x + 0.5, cy = y + 0.55;
  add(x + y + 0.9, ctx => {
    isoBox(ctx, cx - 0.05, cy - 0.05, cx + 0.05, cy + 0.05, 0, 11, "#20232c", { outline: false });
    isoBox(ctx, cx - 0.24, cy - 0.22, cx + 0.24, cy + 0.22, 11, 4, color);
  });
  add(x + y + 1.25, ctx => isoBox(ctx, cx - 0.24, cy + 0.2, cx + 0.24, cy + 0.3, 13, 17, color));
}

function plant(x: number, y: number, tall = false, potColor = "#c46a46") {
  block(x, y, x + 1, y + 1);
  add(x + y + 1, (ctx, t) => {
    isoBox(ctx, x + 0.3, y + 0.3, x + 0.7, y + 0.7, 0, 13, potColor);
    const base = iso(x + 0.5, y + 0.5, 13);
    const sway = Math.sin(t / 1300 + x) * 0.8;
    const leaves = tall ? 9 : 6;
    for (let i = 0; i < leaves; i++) {
      const a = (i / leaves) * Math.PI * 2;
      const hgt = tall ? 10 + i * 3.4 : 4 + (i % 3) * 3;
      const r = tall ? 7 + (i % 3) * 2 : 8;
      const lx = base.x + Math.cos(a) * r + sway * (hgt / 20), ly = base.y - hgt + Math.sin(a) * r * 0.45;
      ctx.fillStyle = i % 2 ? "#4f9a4a" : "#3d7f3c";
      ctx.beginPath(); ctx.ellipse(lx, ly, tall ? 7 : 6, tall ? 4.5 : 4, a, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#2b5a2a"; ctx.lineWidth = 1; ctx.stroke();
    }
    if (tall) { ctx.fillStyle = "#6b4a2e"; ctx.fillRect(base.x - 1, base.y - 30, 2, 18); }
  });
}

function bookshelf(x0: number, y0: number, x1: number, y1: number, h: number, seed: number, faceX = false) {
  block(Math.floor(x0), Math.floor(y0), Math.ceil(x1), Math.ceil(y1));
  add((x0 + x1) / 2 + (y0 + y1) / 2, ctx => {
    isoBox(ctx, x0, y0, x1, y1, 0, h, WOOD_D);
    const shelves = Math.floor(h / 15);
    const drawBooks = (len: number) => {
      for (let s = 0; s < shelves; s++) {
        const top = 4 + s * 15;
        ctx.fillStyle = "#3f2a1a"; ctx.fillRect(1, top, len - 2, 12);
        let u = 2;
        let i = 0;
        while (u < len - 3) {
          const bw = 2.5 + rand(seed + s * 31 + i) * 2.5;
          const bh = 7 + rand(seed + s * 17 + i * 3) * 4;
          const col = ["#c0504d", "#4f81bd", "#9bbb59", "#e8b04b", "#8064a2", "#4bacc6", "#f2f0ea", "#d97d3c"][Math.floor(rand(seed + s + i * 7) * 8)]!;
          ctx.fillStyle = col; ctx.fillRect(u, top + 12 - bh, Math.min(bw, len - 3 - u), bh);
          u += bw + 0.6; i++;
        }
        ctx.fillStyle = "#5a3d26"; ctx.fillRect(0, top + 12, len, 2);
      }
    };
    if (faceX) onFaceX(ctx, x1, y1, h, () => drawBooks((y1 - y0) * 32));
    else onFaceY(ctx, x0, y1, h, () => drawBooks((x1 - x0) * 32));
  });
}

function sofa(x0: number, y0: number, x1: number, y1: number, color: string, backAlongX = true) {
  block(Math.floor(x0), Math.floor(y0), Math.ceil(x1), Math.ceil(y1));
  add((x0 + x1) / 2 + (y0 + y1) / 2 + 0.3, ctx => {
    if (backAlongX) {
      isoBox(ctx, x0, y0, x1, y0 + 0.28, 0, 24, shade(color, 0.92));
      isoBox(ctx, x0, y0 + 0.28, x1, y1, 0, 11, color);
      isoBox(ctx, x0, y0, x0 + 0.18, y1, 0, 17, shade(color, 0.9));
      isoBox(ctx, x1 - 0.18, y0, x1, y1, 0, 17, shade(color, 0.9));
      isoBox(ctx, x0 + 0.3, y0 + 0.3, x0 + 0.62, y0 + 0.45, 11, 9, "#f0d9a8");
    } else {
      isoBox(ctx, x0, y0, x0 + 0.28, y1, 0, 24, shade(color, 0.92));
      isoBox(ctx, x0 + 0.28, y0, x1, y1, 0, 11, color);
      isoBox(ctx, x0, y0, x1, y0 + 0.18, 0, 17, shade(color, 0.9));
      isoBox(ctx, x0, y1 - 0.18, x1, y1, 0, 17, shade(color, 0.9));
    }
  });
}

function rug(x0: number, y0: number, x1: number, y1: number, color: string, border: string) {
  add(-1000 + x0 + y0, ctx => {
    poly(ctx, [iso(x0, y0), iso(x1, y0), iso(x1, y1), iso(x0, y1)], border);
    poly(ctx, [iso(x0 + 0.15, y0 + 0.15), iso(x1 - 0.15, y0 + 0.15), iso(x1 - 0.15, y1 - 0.15), iso(x0 + 0.15, y1 - 0.15)], color);
  });
}

function wallScreen(ax: "x" | "y", a: number, b: number, z0: number, z1: number, draw: (ctx: Ctx, w: number, h: number, t: number, s: FloorScene) => void) {
  // digambar bersama dinding (lihat drawWalls)
  screens.push({ ax, a, b, z0, z1, draw });
}
const screens: { ax: "x" | "y"; a: number; b: number; z0: number; z1: number; draw: (ctx: Ctx, w: number, h: number, t: number, s: FloorScene) => void }[] = [];
const windows: { ax: "x" | "y"; a: number; b: number; seed: number }[] = [];

/* ---------- Lobby */
rug(0.6, 3.6, 3.6, 6.4, "#a8574a", "#7c3a33");
sofa(1, 5.2, 3.2, 6, "#3e5f8a");
add(2.1 + 4.4 + 0.5, ctx => { isoBox(ctx, 1.4, 4.1, 2.8, 4.7, 9, 3, WOOD); isoBox(ctx, 1.5, 4.2, 1.6, 4.3, 0, 9, WOOD_D, { outline: false }); isoBox(ctx, 2.6, 4.5, 2.7, 4.6, 0, 9, WOOD_D, { outline: false }); });
block(1, 4, 3, 5);
workDesk(4, 3, 2, 2, 11, "#4fc3a1");
officeChair(5, 4, "#7a3b2e");
plant(0, 1, true); plant(7, 1); plant(7, 6);
// dispenser
block(0, 0, 1, 1);
add(1, ctx => { isoBox(ctx, 0.25, 0.25, 0.75, 0.75, 0, 26, "#e9edf2"); isoBox(ctx, 0.3, 0.3, 0.7, 0.7, 26, 14, "#8cc8f0", { alpha: 0.85 }); });
windows.push({ ax: "x", a: 0.4, b: 3.6, seed: 2 });
windows.push({ ax: "y", a: 0.4, b: 3.4, seed: 5 });

/* ---------- Riset */
bookshelf(8.15, 0.1, 10.9, 0.55, 58, 3);
workDesk(9, 2, 2, 3, 21);
officeChair(10, 3);
workDesk(13, 2, 2, 3, 37, "#9d8cf0");
officeChair(14, 3);
workDesk(9, 5, 2, 2, 51);
officeChair(9, 6);
workDesk(13, 5, 2, 2, 63, "#9d8cf0");
officeChair(14, 6);
plant(15, 0, true);
windows.push({ ax: "x", a: 11.2, b: 12.8, seed: 9 });

/* ---------- Risk Desk */
workDesk(18, 3, 2, 2, 71, "#7fd4ff");
officeChair(19, 4);
block(22, 0, 23, 2);
add(22 + 1 + 0.5, ctx => {
  for (let i = 0; i < 2; i++) {
    isoBox(ctx, 22.15, 0.1 + i, 22.85, 0.9 + i, 0, 40, "#8a93a8");
    onFaceY(ctx, 22.15, 0.9 + i, 40, () => { ctx.fillStyle = "#6b7488"; for (let k = 0; k < 3; k++) ctx.fillRect(4, 4 + k * 12, 18, 9); ctx.fillStyle = "#cfd5e2"; for (let k = 0; k < 3; k++) ctx.fillRect(11, 7 + k * 12, 5, 2); });
  }
});
plant(22, 6);
plant(16, 6, false, "#5a7fa8");

/* ---------- Execution */
workDesk(25, 3, 3, 3, 81, "#f0b44c");
officeChair(26, 4, "#3b2f2a");
block(29, 0, 30, 5);
add(29.5 + 2.5, (ctx, t) => {
  for (let i = 0; i < 4; i++) {
    const y0 = 0.15 + i * 1.15;
    isoBox(ctx, 29.1, y0, 29.9, y0 + 1, 0, 70, "#262b38");
    onFaceY(ctx, 29.1, y0 + 1, 70, () => {
      for (let k = 0; k < 9; k++) {
        ctx.fillStyle = "#353b4c"; ctx.fillRect(2, 3 + k * 7.3, 21, 5);
        const on = rand(i * 50 + k + Math.floor(t / (300 + k * 40))) > 0.4;
        ctx.fillStyle = on ? (k % 3 === 0 ? "#ffb347" : "#4fd18b") : "#1f4a32"; ctx.fillRect(19, 4.5 + k * 7.3, 2, 2);
        ctx.fillStyle = "#4fd18b"; ctx.fillRect(4, 5 + k * 7.3, 6, 1);
      }
    });
  }
});
glows.push({ gx: 29.5, gy: 2.5, z: 40, r: 60, c: "#4fd18b" });
block(28, 1, 29, 2);
add(28.5 + 1.5, ctx => { isoBox(ctx, 28.4, 1.4, 28.6, 1.6, 0, 52, "#4a4f5e"); });
plant(23, 6, true);

/* ---------- Meeting */
rug(1.2, 8.4, 6.8, 13.6, "#5b4a78", "#3f3357");
block(2, 10, 6, 12);
add(4 + 11, ctx => {
  isoBox(ctx, 2.6, 10.6, 2.75, 10.75, 0, 18, "#2e2a24", { outline: false });
  isoBox(ctx, 5.25, 11.25, 5.4, 11.4, 0, 18, "#2e2a24", { outline: false });
  isoBox(ctx, 2.05, 10.05, 5.95, 11.95, 18, 4, "#8a5a36", { top: "#a8703f" });
  isoBox(ctx, 3, 10.7, 3.4, 10.9, 22, 1, "#f2f0ea"); isoBox(ctx, 4.4, 11.1, 4.8, 11.3, 22, 1, "#f2f0ea");
  isoBox(ctx, 3.9, 10.9, 4.1, 11.1, 22, 5, "#4f9a4a");
});
for (const [cx, cy] of MEETING_SEATS) {
  const front = cy === 9;
  add(cx + cy + (front ? 0.9 : 1.4), ctx => {
    const x = cx + 0.5, y = front ? cy + 0.45 : cy + 0.55;
    isoBox(ctx, x - 0.05, y - 0.05, x + 0.05, y + 0.05, 0, 11, "#20232c", { outline: false });
    isoBox(ctx, x - 0.22, y - 0.2, x + 0.22, y + 0.2, 11, 4, "#4a4458");
    if (front) isoBox(ctx, x - 0.22, y - 0.26, x + 0.22, y - 0.16, 13, 16, "#4a4458");
    else isoBox(ctx, x - 0.22, y + 0.16, x + 0.22, y + 0.26, 13, 16, "#4a4458");
  });
}
plant(7, 14, true); plant(0, 14);
windows.push({ ax: "y", a: 13.2, b: 14.6, seed: 13 });

/* ---------- Jurnal */
bookshelf(8.1, 7.1, 11.9, 7.6, 62, 101);
rug(9.2, 9.2, 14.8, 13.8, "#7a8f5a", "#566b3e");
block(11, 10, 13, 11);
add(12 + 10.5, ctx => {
  isoBox(ctx, 11.05, 10.1, 11.2, 10.25, 0, 20, WOOD_D, { outline: false });
  isoBox(ctx, 12.8, 10.75, 12.95, 10.9, 0, 20, WOOD_D, { outline: false });
  isoBox(ctx, 11, 10.05, 13, 10.95, 20, 4, "#7a4f2e", { top: "#94603a" });
  isoBox(ctx, 11.3, 10.3, 11.9, 10.7, 24, 2, "#f6f1e5");
  isoBox(ctx, 12.4, 10.2, 12.75, 10.5, 24, 9, "#2b3142");
  isoBox(ctx, 12.55, 10.3, 12.65, 10.4, 33, 8, "#e8b04b", { outline: false });
});
glows.push({ gx: 12.6, gy: 10.35, z: 40, r: 40, c: "#ffd27a" });
officeChair(12, 11, "#6b3f2a");
add(14.5 + 8.6, (ctx, _t, s) => s.drawEasel(ctx, 14.5, 8.6));
block(14, 8, 15, 9);
sofa(9, 12.6, 10.2, 13.8, "#a35d3f", false);
plant(15, 14, true); plant(8, 9);

/* ---------- Lounge & Pool */
block(19, 12, 22, 14);
add(-900, (ctx, t) => {
  poly(ctx, [iso(18.8, 11.8), iso(22.2, 11.8), iso(22.2, 14.2), iso(18.8, 14.2)], "#e8e2d4", "#b9b2a2");
  poly(ctx, [iso(19, 12), iso(22, 12), iso(22, 14), iso(19, 14)], "#3fa7c9");
  ctx.save();
  ctx.beginPath(); const q = [iso(19, 12), iso(22, 12), iso(22, 14), iso(19, 14)]; ctx.moveTo(q[0]!.x, q[0]!.y); q.slice(1).forEach(p => ctx.lineTo(p.x, p.y)); ctx.closePath(); ctx.clip();
  for (let i = 0; i < 14; i++) {
    const gx = 19 + rand(i) * 3, gy = 12 + ((rand(i + 9) * 2 + t / 4000) % 2);
    const p = iso(gx, gy);
    ctx.fillStyle = "rgba(255,255,255,.55)"; ctx.fillRect(p.x - 5, p.y, 10, 1.5);
  }
  ctx.restore();
  // bebek karet
  const dk = iso(20.5 + Math.sin(t / 3000) * 0.9, 13 + Math.cos(t / 3700) * 0.5, 1 + Math.sin(t / 500));
  ctx.fillStyle = "#f6d548"; ctx.strokeStyle = "#8a6a10"; ctx.lineWidth = 1;
  roundRect(ctx, dk.x - 5, dk.y - 4, 10, 5, 2); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.arc(dk.x + 3, dk.y - 6, 3, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = "#e9734b"; ctx.fillRect(dk.x + 5.5, dk.y - 6, 2.5, 1.5);
});
for (const [lx, ly] of [[17, 13.2], [17, 14.1]] as const) {
  block(17, Math.floor(ly), 18, Math.floor(ly) + 1);
  add(lx + ly + 1, ctx => { isoBox(ctx, lx + 0.1, ly + 0.1, lx + 0.95, ly + 0.75, 4, 4, "#f2f0ea"); isoBox(ctx, lx + 0.1, ly + 0.1, lx + 0.3, ly + 0.75, 8, 10, "#e9734b"); });
}
add(22.4 + 14.5, ctx => {
  const p = iso(22.5, 14.5);
  ctx.fillStyle = "#6b4a2e"; ctx.fillRect(p.x - 1, p.y - 52, 2, 52);
  ctx.fillStyle = "#e9734b"; ctx.beginPath(); ctx.moveTo(p.x - 28, p.y - 46); ctx.lineTo(p.x, p.y - 62); ctx.lineTo(p.x + 28, p.y - 46); ctx.closePath(); ctx.fill();
  ctx.fillStyle = "#f6f1e5"; ctx.beginPath(); ctx.moveTo(p.x - 9, p.y - 50); ctx.lineTo(p.x, p.y - 62); ctx.lineTo(p.x + 9, p.y - 50); ctx.closePath(); ctx.fill();
});
block(22, 14, 23, 15);
sofa(17, 8, 19, 8.9, "#3d7f7a");
block(21, 7, 23, 8);
add(22 + 7.5, ctx => {
  isoBox(ctx, 21.05, 7.1, 22.95, 7.85, 0, 30, "#6e4a2e", { top: "#d9cbb2" });
  isoBox(ctx, 21.3, 7.25, 21.7, 7.6, 30, 14, "#2b3142");
  steam(ctx, iso(21.5, 7.55, 44), performance.now(), 3);
  isoBox(ctx, 22.1, 7.3, 22.25, 7.45, 30, 5, "#f2f0ea"); isoBox(ctx, 22.4, 7.3, 22.55, 7.45, 30, 5, "#e06c5a");
});
for (const [bx, by, c] of [[21, 10, "#e8b04b"], [20, 10, "#e9734b"]] as const) {
  block(bx, by, bx + 1, by + 1);
  add(bx + by + 1, ctx => { const p = iso(bx + 0.5, by + 0.5); ctx.fillStyle = c; ctx.beginPath(); ctx.ellipse(p.x, p.y - 7, 15, 10, 0, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = shade(c, 0.5); ctx.lineWidth = 1.5; ctx.stroke(); ctx.fillStyle = shade(c, 1.15); ctx.beginPath(); ctx.ellipse(p.x - 3, p.y - 11, 7, 4, 0, 0, Math.PI * 2); ctx.fill(); });
}
plant(16, 14, true); plant(16, 7);

/* ---------- Ruang Bos */
rug(24.2, 8.6, 28.8, 12.4, "#2f3a56", "#c9a341");
block(25, 10, 28, 11);
add(26.5 + 10.5 + 0.2, (ctx, _t, s) => {
  isoBox(ctx, 25, 10.05, 28, 10.95, 0, 22, "#4a2f20", { top: "#6b4430" });
  isoBox(ctx, 25.3, 10.2, 25.9, 10.5, 22, 1, "#f6f1e5");
  isoBox(ctx, 26.9, 10.25, 27.6, 10.4, 22, 13, "#1c2130");
  isoBox(ctx, 27.75, 10.3, 27.85, 10.4, 22, 10, "#c9a341", { outline: false });
  s.drawTray(ctx, 26.2, 10.5);
});
glows.push({ gx: 27.8, gy: 10.35, z: 36, r: 36, c: "#ffd27a" });
add(26.5 + 9.3, ctx => { // kursi kulit bos di belakang meja
  isoBox(ctx, 26.2, 9.1, 26.8, 9.25, 12, 26, "#5a2e22");
  isoBox(ctx, 26.2, 9.25, 26.8, 9.8, 10, 4, "#6e3a2a");
});
bookshelf(27.1, 7.1, 29.9, 7.55, 64, 211);
sofa(24, 13.2, 26.2, 14, "#2f3a56");
// Layar besar "EQUITY LIVE" berdiri di depan partisi
block(23, 7, 26, 8);
add(24.5 + 7.6, (ctx, t, s) => s.drawEquityBoard(ctx, t));
glows.push({ gx: 24.6, gy: 7.6, z: 60, r: 70, c: "#6fcf8e" });
plant(23, 14, true); plant(29, 14);

/* ---------- papan berdiri (layar/whiteboard) untuk ruangan tanpa dinding belakang */
function standBoard(x0: number, x1: number, y: number, h: number, title: string, color: string,
  draw: (ctx: Ctx, w: number, hh: number, t: number, s: FloorScene) => void, light = false) {
  block(Math.floor(x0), Math.floor(y), Math.ceil(x1), Math.floor(y) + 1);
  add((x0 + x1) / 2 + y + 0.45, (ctx, t, s) => {
    isoBox(ctx, x0 + 0.15, y + 0.05, x0 + 0.25, y + 0.15, 0, 24, "#2a2f3c", { outline: false });
    isoBox(ctx, x1 - 0.25, y + 0.05, x1 - 0.15, y + 0.15, 0, 24, "#2a2f3c", { outline: false });
    isoBox(ctx, x0, y, x1, y + 0.15, 24, h, light ? "#d9d4c7" : "#1c2131");
    onFaceY(ctx, x0 + 0.08, y + 0.15, 24 + h - 3, () => {
      const w = (x1 - x0 - 0.16) * 32, hh = h - 6;
      ctx.fillStyle = light ? "#f6f1e5" : "#0b1020"; ctx.fillRect(0, 0, w, hh);
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, w, hh); ctx.clip();
      px(ctx, title, 4, 9, 7, color);
      draw(ctx, w, hh, t, s);
      ctx.restore();
    });
  });
  glows.push({ gx: (x0 + x1) / 2, gy: y + 0.3, z: 24 + h / 2, r: 60, c: light ? "#ffd27a" : color });
}
const REG_COLOR: Record<string, string> = { tren_naik: "#4fd18b", tren_turun: "#ef6b57", sideways: "#f3d25b", volatil: "#c47cff", transisi: "#a4a9bd" };
const hm = (iso: string) => new Date(Date.parse(iso) + 7 * 3_600_000).toISOString().slice(11, 16);

/* ---------- Ruang Server (ops) */
for (let i = 0; i < 3; i++) {
  const y0 = 19.05 + i * 0.97;
  add(0.5 + y0 + 0.5, (ctx, t) => {
    isoBox(ctx, 0.1, y0, 0.9, y0 + 0.9, 0, 72, "#262b38");
    onFaceX(ctx, 0.9, y0 + 0.9, 72, () => {
      for (let k = 0; k < 9; k++) {
        ctx.fillStyle = "#353b4c"; ctx.fillRect(2, 3 + k * 7.5, 24, 5.5);
        const on = rand(i * 70 + k + Math.floor(t / (260 + k * 50))) > 0.35;
        ctx.fillStyle = on ? (k % 4 === 0 ? "#ffb347" : "#4fd18b") : "#1f4a32"; ctx.fillRect(21, 4.5 + k * 7.5, 2, 2);
        ctx.fillStyle = "#63c7b2"; ctx.fillRect(4, 5 + k * 7.5, 8, 1);
      }
    });
  });
}
block(0, 19, 1, 22);
glows.push({ gx: 0.8, gy: 20.5, z: 40, r: 70, c: "#4fd18b" });
workDesk(2, 17, 3, 3, 301, "#63c7b2");
officeChair(3, 18, "#2d3240");
plant(5, 21, true); plant(5, 15);
wallScreen("y", 15.4, 18.6, 30, 90, (ctx, w, _h, t, s) => {
  const o = s.data?.ops;
  px(ctx, "STATUS SISTEM", 6, 13, 9, "#63c7b2");
  const dot = (y: number, label: string, st: string) => {
    const ok = st === "hidup";
    const blink = !ok && Math.floor(t / 500) % 2 === 0;
    ctx.fillStyle = ok ? "#4fd18b" : st === "belum pernah jalan" ? "#6b7280" : blink ? "#ef6b57" : "#7a2e26";
    ctx.beginPath(); ctx.arc(10, y - 3, 3, 0, Math.PI * 2); ctx.fill();
    px(ctx, `${label} ${st.toUpperCase()}`, 17, y, 7.5, ok ? "#ece6d8" : "#f3b0a6", 500);
  };
  dot(29, "BOT", o?.bot ?? "-");
  dot(42, "NOTIF", o?.notifier ?? "-");
  px(ctx, `ERROR HARI INI ${o?.errors ?? 0}`, 6, 55, 7.5, (o?.errors ?? 0) > 0 ? "#ef6b57" : "#a4a9bd", 500);
  px(ctx, `TICK TERAKHIR ${o?.lastTick ?? "-"}`, 6, 66, 7, "#a4a9bd", 500);
  void w;
});
glows.push({ gx: 0.3, gy: 17, z: 60, r: 70, c: "#63c7b2" });

/* ---------- Ruang Regime */
standBoard(6.2, 8.9, 15.3, 62, "REGIME 4H", "#7fd4ff", (ctx, w, _hh, _t, s) => {
  const rows = s.data?.regime.rows ?? [];
  if (!rows.length) { px(ctx, "menunggu data", 4, 24, 6.5, "#a4a9bd", 500); return; }
  rows.slice(0, 5).forEach((r, i) => {
    const y = 20 + i * 8;
    px(ctx, r.symbol.replace("USDT", ""), 4, y, 6.5, "#ece6d8", 500);
    ctx.fillStyle = REG_COLOR[r.regime] ?? "#a4a9bd"; ctx.fillRect(w - 44, y - 6, 40, 7);
    px(ctx, r.label.toUpperCase().slice(0, 10), w - 42, y - 0.5, 5, "#0b1020");
  });
});
standBoard(10.1, 11.9, 15.3, 62, "COCOK?", "#7fd4ff", (ctx, w, _hh, _t, s) => {
  const fits = s.data?.regime.fits ?? [];
  if (!fits.length) { px(ctx, "-", 4, 24, 6.5, "#a4a9bd", 500); return; }
  fits.slice(0, 5).forEach((f, i) => {
    const y = 20 + i * 8;
    px(ctx, f.key.split(" ")[0]!.replace("USDT", "").slice(0, 5), 4, y, 6, "#ece6d8", 500);
    px(ctx, f.fit === "cocok" ? "✓" : f.fit === "kurang cocok" ? "✗" : "~", w - 10, y, 7, f.fit === "cocok" ? "#4fd18b" : f.fit === "kurang cocok" ? "#ef6b57" : "#a4a9bd");
  });
});
workDesk(7, 19, 2, 2, 331, "#7fd4ff");
officeChair(8, 20);
workDesk(10, 19, 1, 1, 337, "#7fd4ff");
officeChair(10, 20);
plant(11, 21, true); plant(6, 21);

/* ---------- Meja Berita */
standBoard(15.1, 17.9, 15.3, 64, "BERITA BESAR", "#f0b44c", (ctx, w, hh, t, s) => {
  const n = s.data?.news;
  if (!n || (!n.next && !n.upcoming.length)) { px(ctx, "menunggu kalender", 4, 24, 6.5, "#a4a9bd", 500); return; }
  if (n.near && Math.floor(t / 600) % 2 === 0) { ctx.fillStyle = "#ef6b57"; ctx.fillRect(0, hh - 10, w, 10); px(ctx, "JENDELA BERITA", 4, hh - 2.5, 6.5, "#fff"); }
  if (n.next) {
    const mins = Math.round((Date.parse(n.next.at) - Date.now()) / 60_000);
    const cd = mins >= 60 * 24 ? `${Math.floor(mins / 1440)}h ${Math.floor((mins % 1440) / 60)}j` : `${Math.floor(mins / 60)}j ${mins % 60}m`;
    px(ctx, `T-${cd}`, 4, 21, 9, "#ece6d8");
    px(ctx, n.next.title.slice(0, 22), 4, 30, 6, "#a4a9bd", 500);
  }
  n.upcoming.slice(0, 3).forEach((e, i) => px(ctx, `${hm(e.at)} ${e.title.slice(0, 16)}`, 4, 40 + i * 7, 5.5, e.impact === "High" ? "#f3b0a6" : "#a4a9bd", 500));
});
standBoard(12.2, 13.9, 15.3, 50, "WIB", "#f0b44c", (ctx, w) => {
  const now = new Date(Date.now() + 7 * 3_600_000);
  px(ctx, now.toISOString().slice(11, 16), 4, 26, 11, "#ece6d8");
  px(ctx, ["MIN", "SEN", "SEL", "RAB", "KAM", "JUM", "SAB"][now.getUTCDay()]!, 4, 36, 6.5, "#a4a9bd", 500);
  void w;
});
workDesk(13, 18, 2, 2, 351, "#f0b44c");
officeChair(14, 19, "#6b3f2a");
sofa(15.3, 20.3, 17.6, 21.1, "#7a3b4a");
plant(12, 21, true); plant(17, 16);

/* ---------- Lab R&D */
standBoard(18.2, 20.9, 15.3, 62, "LAB R&D", "#3e6b4a", (ctx, w, _hh, _t, s) => {
  const rows = s.data?.labRows ?? [];
  if (!rows.length) { px(ctx, "belum ada uji ulang", 4, 24, 6, "#5a5d6a", 500); return; }
  const col: Record<string, string> = { stabil: "#3e9e62", membaik: "#3b7fc4", melemah: "#d24d3b", "tanpa edge": "#8a2d22", "sampel kecil": "#8b8fa3", gagal: "#c08a1e" };
  rows.slice(0, 5).forEach((r, i) => {
    const y = 20 + i * 8;
    px(ctx, r.key.split(" ")[0]!.replace("USDT", "").slice(0, 5), 4, y, 6, "#2a2d3a", 500);
    ctx.fillStyle = col[r.status] ?? "#8b8fa3"; ctx.fillRect(w - 46, y - 6, 42, 7);
    px(ctx, r.status.toUpperCase().slice(0, 11), w - 44, y - 0.5, 4.8, "#fff");
  });
}, true);
block(19, 18, 22, 19);
add(20.5 + 18.5, (ctx, t) => {
  isoBox(ctx, 19, 18.1, 22, 18.9, 0, 22, "#e9edf2", { top: "#f6f8fa" });
  for (let i = 0; i < 3; i++) {
    isoBox(ctx, 19.3 + i, 18.3, 19.7 + i, 18.45, 22, 14, "#1c2130");
    onFaceY(ctx, 19.33 + i, 18.45, 35, () => chart(ctx, 11, 11, 500 + i * 9, t, i === 1 ? "#5fb7e6" : undefined));
  }
  isoBox(ctx, 21.6, 18.55, 21.8, 18.75, 22, 7, "#8cc8f0", { alpha: 0.85 });
});
officeChair(20, 19, "#e9edf2");
block(23, 16, 24, 17);
add(23.5 + 16.5, (ctx, t) => {
  isoBox(ctx, 23.1, 16.1, 23.9, 16.9, 0, 56, "#2b3142");
  const p = iso(23.5, 16.9, 40); ctx.fillStyle = Math.floor(t / 300) % 2 ? "#4fd18b" : "#1f4a32"; ctx.fillRect(p.x - 2, p.y, 4, 2);
});
plant(18, 21, true); plant(23, 21);

/* ---------- Ruang Review */
standBoard(24.2, 26.9, 15.3, 62, "REVIEW MINGGUAN", "#c9a341", (ctx, _w, _hh, _t, s) => {
  const lines = s.data?.reviewLines ?? [];
  if (!lines.length) { px(ctx, "tiap Minggu 21:00", 4, 24, 6, "#a4a9bd", 500); return; }
  lines.slice(0, 5).forEach((l, i) => px(ctx, l, 4, 21 + i * 8, i === 0 ? 7 : 6, i === 0 ? "#ece6d8" : "#a4a9bd", 500));
});
bookshelf(28.1, 15.1, 29.9, 15.55, 60, 401);
rug(25.4, 17.4, 29.6, 20.6, "#4a3b2a", "#c9a341");
block(26, 18, 29, 20);
add(27.5 + 19, ctx => {
  isoBox(ctx, 26.6, 18.6, 26.75, 18.75, 0, 18, "#2e2a24", { outline: false });
  isoBox(ctx, 28.25, 19.25, 28.4, 19.4, 0, 18, "#2e2a24", { outline: false });
  isoBox(ctx, 26.1, 18.1, 28.9, 19.9, 18, 4, "#7a4f2e", { top: "#94603a" });
  isoBox(ctx, 26.6, 18.6, 27.1, 18.9, 22, 1, "#f6f1e5"); isoBox(ctx, 27.8, 19.1, 28.3, 19.4, 22, 1, "#f6f1e5");
  isoBox(ctx, 27.4, 18.8, 27.6, 19.0, 22, 9, "#c9a341");
});
plant(24, 21, true); plant(35, 21);
sofa(31.3, 20.3, 33.7, 21.1, "#5a4a3a");
plant(30, 16); bookshelf(34.1, 15.1, 35.9, 15.55, 58, 433);

/* ---------- Ruang Scalping (riset fase 1, belum ada order) */
wallScreen("x", 30.5, 35.5, 30, 84, (ctx, w, _h, t, s) => {
  const d = s.data?.scalp;
  px(ctx, "MEJA 1H · LIVE", 6, 13, 9, "#ff9f43");
  if (!d) { px(ctx, "memuat…", 6, 32, 7.5, "#a4a9bd", 500); return; }
  d.lines.slice(0, 3).forEach((l, i) => px(ctx, l, 6, 28 + i * 11, 7.5, /LONG|SHORT/.test(l) ? "#4fd18b" : "#ece6d8", 500));
  px(ctx, d.verdict, 6, 64, 7, "#a4a9bd", 500);
  void t;
});
workDesk(31, 3, 2, 3, 611, "#ff9f43"); officeChair(32, 4, "#8a4b1e");
workDesk(33, 3, 2, 3, 627, "#ff9f43"); officeChair(34, 4, "#8a4b1e");
workDesk(31, 7, 2, 2, 643, "#ffcf6e"); officeChair(32, 8, "#2d3240");
workDesk(33, 7, 2, 2, 659, "#ffcf6e"); officeChair(34, 8, "#2d3240");
standBoard(30.4, 32.8, 11.3, 52, "RISET SCALPING", "#ff9f43", (ctx, w, _hh, _t, s) => {
  const d = s.data?.scalp;
  px(ctx, d?.best ?? "belum ada riset", 4, 22, 6, "#ece6d8", 500);
  px(ctx, "hasil: tidak layak", 4, 32, 6, "#ef6b57", 500);
  void w;
});
plant(35, 1, true); plant(35, 13); plant(30, 6);
glows.push({ gx: 33, gy: 5, z: 50, r: 80, c: "#ff9f43" });

/* ---------- partisi */
interface Part { x0: number; y0: number; x1: number; y1: number; glass: boolean }
const PARTS: Part[] = [];
const GLASS: RoomId[] = ["risk", "meeting", "ops", "lab"];
const isGlass = (a?: RoomId, b?: RoomId) => GLASS.includes(a!) || GLASS.includes(b!);
[8, 16, 23, 30].forEach(bx => {
  for (let y = 0; y < 15; y++) {
    if (y === 3 || y === 11) continue;
    PARTS.push({ x0: bx - 0.06, y0: y, x1: bx + 0.06, y1: y + 1, glass: isGlass(roomOf(bx - 1, y)?.id, roomOf(bx, y)?.id) });
  }
});
for (let x = 0; x < GW; x++) {
  if ([4, 12, 19, 26].includes(x) || roomOf(x, 6)?.id === roomOf(x, 7)?.id) continue;
  PARTS.push({ x0: x, y0: 6.94, x1: x + 1, y1: 7.06, glass: isGlass(roomOf(x, 6)?.id, roomOf(x, 7)?.id) });
}
for (let x = 0; x < GW; x++) {
  if ([3, 9, 14, 21, 27, 33].includes(x)) continue;
  PARTS.push({ x0: x, y0: 14.94, x1: x + 1, y1: 15.06, glass: isGlass(roomOf(x, 14)?.id, roomOf(x, 15)?.id) });
}
[6, 12, 18, 24].forEach(bx => {
  for (let y = 15; y < GH; y++) {
    if (y === 18) continue;
    PARTS.push({ x0: bx - 0.06, y0: y, x1: bx + 0.06, y1: y + 1, glass: isGlass(roomOf(bx - 1, y)?.id, roomOf(bx, y)?.id) });
  }
});
for (const p of PARTS) {
  add((p.x0 + p.x1) / 2 + (p.y0 + p.y1) / 2 + 0.45, ctx => {
    if (p.glass) {
      isoBox(ctx, p.x0, p.y0, p.x1, p.y1, 0, 6, "#c8ccd6");
      isoBox(ctx, p.x0, p.y0, p.x1, p.y1, 6, 52, "#bfe3f5", { alpha: 0.32, outline: "rgba(120,160,190,.6)" });
      isoBox(ctx, p.x0, p.y0, p.x1, p.y1, 58, 3, "#9aa3b5");
    } else {
      isoBox(ctx, p.x0, p.y0, p.x1, p.y1, 0, 34, "#e9e1d2", { top: "#8a7a62" });
    }
  });
}

/* ---------- papan & layar dinding (konten dari SceneData) */
wallScreen("x", 4.2, 7.6, 30, 84, (ctx, w, _h, _t, s) => {
  const d = s.data;
  px(ctx, "MARKET HARI INI", 6, 13, 9, "#f0b44c");
  const rows = d?.prices.slice(0, 3) ?? [];
  if (!rows.length) px(ctx, "menunggu harga…", 6, 30, 8, "#a4a9bd", 500);
  rows.forEach((p, i) => {
    px(ctx, p.symbol.replace("USDT", ""), 6, 29 + i * 11, 8.5, "#ece6d8", 500);
    px(ctx, fmt(p.last, priceDp(p.last)), 40, 29 + i * 11, 8.5, "#ece6d8", 500);
    if (p.chgPct != null) px(ctx, `${p.chgPct > 0 ? "+" : ""}${p.chgPct.toFixed(1)}%`, w - 34, 29 + i * 11, 8, p.chgPct < 0 ? "#ef6b57" : "#4fd18b", 500);
  });
  if (d?.fundingBtc != null) px(ctx, `FUNDING BTC ${d.fundingBtc.toFixed(4)}%`, 6, 64, 7, "#a4a9bd", 500);
});
wallScreen("x", 13, 15.7, 34, 84, (ctx, w, h, t, s) => {
  const d = s.data;
  px(ctx, "SCAN TERAKHIR", 5, 12, 8.5, "#5fb7e6");
  const rows = d?.board ?? [];
  if (!rows.length) { px(ctx, "belum ada scan", 5, 28, 7.5, "#a4a9bd", 500); return; }
  const maxV = Math.max(10, ...rows.map(r => Math.abs(r.ret ?? 0)));
  rows.slice(0, 4).forEach((r, i) => {
    const y = 20 + i * 9;
    px(ctx, r.label.split(" ")[0]!, 5, y + 6, 7, "#ece6d8", 500);
    const len = Math.max(1, Math.abs(r.ret ?? 0) / maxV * (w - 40));
    ctx.fillStyle = (r.ret ?? 0) < 0 ? "#ef6b57" : "#4fd18b"; ctx.fillRect(34, y, len, 5);
  });
  void h; void t;
});
wallScreen("x", 16.5, 19.6, 30, 84, (ctx, _w, _h, _t, s) => {
  const d = s.data;
  px(ctx, "RISK DESK", 6, 13, 9, "#7fd4ff");
  if (d?.killSwitch) px(ctx, "STOP", 70, 13, 8, "#ef6b57");
  px(ctx, `EXPOSURE ${d?.exposurePct != null ? fmt(d.exposurePct, 0) : "-"}%`, 6, 25, 7.5, "#ece6d8", 500);
  px(ctx, `DITOLAK ${d?.rejectedToday ?? 0}`, 6, 35, 7.5, "#ece6d8", 500);
  // meteran rugi harian: hijau < 50%, kuning < 85%, merah >= 85% dari batas
  const used = d?.lossUsed;
  px(ctx, used == null ? "RUGI HARIAN -" : `RUGI HARIAN ${Math.min(999, used).toFixed(0)}% BATAS`, 6, 44, 6.5, "#a4a9bd", 500);
  ctx.fillStyle = "#1c2338"; ctx.fillRect(6, 46.5, 84, 5);
  if (used != null) { ctx.fillStyle = used >= 85 ? "#ef6b57" : used >= 50 ? "#f3d25b" : "#4fd18b"; ctx.fillRect(6, 46.5, Math.max(1.5, Math.min(84, used / 100 * 84)), 5); }
});
wallScreen("x", 23.5, 27.4, 30, 84, (ctx, w, _h, t, s) => {
  const d = s.data;
  const live = d?.mode === "LIVE";
  px(ctx, "EXECUTION", 6, 13, 9, "#f0b44c");
  px(ctx, d?.mode ?? "-", w - 40, 13, 8.5, live ? "#ef6b57" : "#63c7b2");
  const open = (d?.positions ?? []).filter(p => p.tf !== "1h"); // posisi 1h tampil di meja 1h (Ruang Scalping)
  px(ctx, open.length ? `${open[0]!.symbol.replace("USDT", "")} ${open[0]!.side.toUpperCase()}${open.length > 1 ? ` +${open.length - 1}` : ""}` : "TIDAK ADA POSISI", 6, 29, 8, open.length ? "#4fd18b" : "#ece6d8", 500);
  if (d?.autoEntry && live && Math.floor(t / 700) % 2 === 0) px(ctx, "ENTRY OTOMATIS", 6, 42, 7.5, "#f3d25b");
  ctx.save(); ctx.translate(6, 48); chart(ctx, w - 12, 20, 400, t); ctx.restore();
});
wallScreen("y", 9, 12.6, 34, 84, (ctx, w, _h, t, s) => {
  // TV ruang meeting: agenda = bubble agent yang sedang meeting
  const m = s.data?.agents.find(a => a.state === "meeting");
  const urgent = m?.bubble.startsWith("Rapat darurat") ?? false;
  px(ctx, urgent ? "DARURAT" : "AGENDA", 6, 13, 9, urgent ? "#ef6b57" : "#63c7b2");
  ctx.font = `500 8px "Pixelify Sans", monospace`;
  const text = m?.bubble || "Tidak ada meeting";
  const words = text.split(" "); let line = ""; let y = 28;
  for (const wd of words) {
    if (ctx.measureText(line + wd).width > w - 12 && line) { px(ctx, line.trim(), 6, y, 8, "#ece6d8", 500); line = ""; y += 11; if (y > 60) break; }
    line += wd + " ";
  }
  if (y <= 60) px(ctx, line.trim(), 6, y, 8, "#ece6d8", 500);
  void t;
});
wallScreen("y", 3.5, 4.0, 64, 80, (ctx, w, h) => { // jam dinding, waktu WIB
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
  const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 0.5;
  ctx.fillStyle = "#fbf8f1"; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "#1d1b22"; ctx.lineWidth = 1.2; ctx.stroke();
  const hand = (ang: number, len: number, wd: number) => { ctx.lineWidth = wd; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.sin(ang) * len, cy - Math.cos(ang) * len); ctx.stroke(); };
  hand(((now.getHours() % 12) + now.getMinutes() / 60) / 12 * Math.PI * 2, r * 0.5, 1.4);
  hand(now.getMinutes() / 60 * Math.PI * 2, r * 0.8, 1);
});
wallScreen("y", 4, 6.6, 46, 74, (ctx, w) => { // logo kantor
  ctx.fillStyle = "#232a3d"; ctx.fillRect(0, 0, w, 28);
  ctx.fillStyle = "#f0b44c"; ctx.fillRect(6, 8, 8, 8); ctx.fillStyle = "#63c7b2"; ctx.fillRect(10, 12, 8, 8);
  px(ctx, "TRADING", 24, 13, 8, "#ece6d8"); px(ctx, "FLOOR", 24, 23, 8, "#f0b44c");
});

/* ================================================================== pathfinding */

function canStep(ax: number, ay: number, bx: number, by: number) {
  if (bx < 0 || by < 0 || bx >= GW || by >= GH) return false;
  if (blocked.has(key(bx, by))) return false;
  if (roomOf(ax, ay) !== roomOf(bx, by)) return doors.has(key(ax, ay) + "|" + key(bx, by));
  return true;
}
function findPath(sx: number, sy: number, tx: number, ty: number): Cell[] {
  if (sx === tx && sy === ty) return [];
  const prev = new Map<string, Cell | null>([[key(sx, sy), null]]);
  const q: Cell[] = [[sx, sy]];
  while (q.length) {
    const [x, y] = q.shift()!;
    if (x === tx && y === ty) break;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx, ny = y + dy, k = key(nx, ny);
      if (prev.has(k) || nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue;
      const isTarget = nx === tx && ny === ty;
      if (isTarget ? (roomOf(x, y) !== roomOf(nx, ny) && !doors.has(key(x, y) + "|" + k)) : !canStep(x, y, nx, ny)) continue;
      prev.set(k, [x, y]); q.push([nx, ny]);
    }
  }
  if (!prev.has(key(tx, ty))) return [];
  const path: Cell[] = []; let cur: Cell | null | undefined = [tx, ty];
  while (cur && !(cur[0] === sx && cur[1] === sy)) { path.unshift(cur); cur = prev.get(key(...cur)); }
  return path;
}

/* ================================================================== characters */

type Hair = "short" | "spiky" | "long" | "bun" | "curly" | "neat" | "cap";
interface Look { skin: string; hair: string; hairStyle: Hair; shirt: string; pants: string; glasses?: boolean; tie?: string; cap?: string }
const NPC_LOOKS: Record<"ob" | "satpam" | "scalper", Look> = {
  scalper: { skin: "#d9a57a", hair: "#2a1d14", hairStyle: "spiky", shirt: "#ff9f43", pants: "#2b2f3d", glasses: true },
  ob: { skin: "#c98f62", hair: "#1b1716", hairStyle: "cap", shirt: "#6c8ebf", pants: "#2f3a56", cap: "#3d5a8a" },
  satpam: { skin: "#b97f55", hair: "#1b1716", hairStyle: "cap", shirt: "#3b4a6b", pants: "#1f2433", cap: "#1f2433", tie: "#1f2433" },
};

function drawCat(ctx: Ctx, a: Person, t: number) {
  const p = iso(a.x, a.y);
  const moving = a.path.length > 0;
  const f = a.face, x = p.x, y = p.y;
  const O = "#3a2a1c", C = "#e8a04b", D = "#c97e2e";
  ctx.fillStyle = "rgba(20,15,25,.22)"; ctx.beginPath(); ctx.ellipse(x, y, 8, 3, 0, 0, Math.PI * 2); ctx.fill();
  const hop = moving ? Math.abs(Math.sin(t / 80)) * 1.5 : 0;
  ctx.strokeStyle = O; ctx.lineWidth = 1;
  // ekor
  const tw = Math.sin(t / 300) * 3;
  ctx.fillStyle = C; ctx.fillRect(x - 9 * f + (f > 0 ? 0 : -2), y - 10 - hop + tw * 0.3, 2, 8);
  // badan
  ctx.fillStyle = C; roundRect(ctx, x - 7, y - 9 - hop, 14, 7, 3); ctx.fill(); ctx.stroke();
  ctx.fillStyle = D; ctx.fillRect(x - 3, y - 9 - hop, 2, 6); ctx.fillRect(x + 1, y - 9 - hop, 2, 6);
  if (moving) { ctx.fillStyle = C; ctx.fillRect(x - 5, y - 3, 2, 3); ctx.fillRect(x + 3, y - 3, 2, 3); }
  // kepala
  const hx = x + 7 * f, hy = y - 13 - hop;
  ctx.fillStyle = C; roundRect(ctx, hx - 5, hy - 4, 10, 8, 3); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(hx - 5, hy - 2); ctx.lineTo(hx - 4, hy - 8); ctx.lineTo(hx - 1, hy - 4); ctx.fill();
  ctx.beginPath(); ctx.moveTo(hx + 5, hy - 2); ctx.lineTo(hx + 4, hy - 8); ctx.lineTo(hx + 1, hy - 4); ctx.fill();
  const blink = Math.floor(t / 2600) % 7 === 0;
  ctx.fillStyle = "#1d1b22"; ctx.fillRect(hx - 3 + f, hy - 1, 1.5, blink ? 0.6 : 2); ctx.fillRect(hx + 1.5 + f, hy - 1, 1.5, blink ? 0.6 : 2);
  ctx.fillStyle = "#e86e8a"; ctx.fillRect(hx - 0.5 + f, hy + 1.5, 1.2, 1);
  a.screen = { x, head: hy - 8, feet: y };
}

const LOOKS: Record<Who, Look> = {
  raka: { skin: "#e3b48a", hair: "#2a1d16", hairStyle: "spiky", shirt: "#f2f0ea", pants: "#2f3a56", tie: "#d9774f" },
  tio: { skin: "#c98f62", hair: "#1b1716", hairStyle: "short", shirt: "#5aa6c9", pants: "#3a3f4f", glasses: true },
  sendi: { skin: "#e8bf98", hair: "#4a3020", hairStyle: "curly", shirt: "#8a7fd0", pants: "#2f3446" },
  rini: { skin: "#f0c8a2", hair: "#3b2418", hairStyle: "long", shirt: "#4f9a6e", pants: "#2f3446" },
  eko: { skin: "#b97f55", hair: "#1f1a1a", hairStyle: "cap", shirt: "#c9a341", pants: "#3a3f4f" },
  lala: { skin: "#f2cfae", hair: "#6a3a28", hairStyle: "bun", shirt: "#d0698f", pants: "#4a4458", glasses: true },
  bos: { skin: "#d9a57a", hair: "#151515", hairStyle: "neat", shirt: "#2f3a56", pants: "#1f2433", tie: "#c9a341" },
};

interface Person {
  id: Who | NpcId; nama: string; jabatan: string; color: string; look: Look;
  seat: Cell; x: number; y: number; path: Cell[]; target: Cell;
  state: AgentState; bubble: string; bob: number; face: 1 | -1; bos?: boolean;
  screen?: { x: number; head: number; feet: number };
  /** Jalan sebentar dari meja (ngopi, ambil minum, cari buku) lalu kembali. Murni visual. */
  errand?: { spot: Cell; phase: "go" | "stay" | "back"; until: number; emote: string } | null;
  nextAct: number;
  placed?: boolean;
  emote?: { text: string; until: number } | null;
  npc?: { kind: "human" | "cat"; route: Cell[]; pauseMin: number; pauseMax: number; carry?: boolean; speed: number };
}

type NpcId = "ob" | "satpam" | "kucing" | "scalper";

/** Tempat tujuan "jalan sebentar" + emote yang muncul saat sampai. */
const ERRANDS: { spot: Cell; emote: string }[] = [
  { spot: [3, 19], emote: "🖥️" },
  { spot: [9, 18], emote: "🧭" },
  { spot: [15, 19], emote: "📰" },
  { spot: [21, 17], emote: "🧪" },
  { spot: [25, 17], emote: "📋" },
  { spot: [22, 8], emote: "☕" },
  { spot: [1, 0], emote: "💧" },
  { spot: [9, 1], emote: "📚" },
  { spot: [10, 8], emote: "📚" },
  { spot: [12, 1], emote: "🌆" },
  { spot: [20, 9], emote: "☕" },
];

function drawCharacter(ctx: Ctx, a: Person, t: number, seat: "back" | "front" | null) {
  const seated = seat !== null;
  const L = a.look;
  const p = iso(a.x, a.y);
  const moving = a.path.length > 0;
  let x = p.x; const y = p.y;
  if (a.state === "alert") x += Math.sin(t / 40) * 1.5;
  const bob = moving ? Math.abs(Math.sin(t / 120 + a.bob)) * 2.5 : Math.sin(t / 800 + a.bob) * 0.6;
  const back = seat === "back"; // duduk di meja = terlihat dari belakang, seperti di video
  const f = a.face;
  const O = "#1d1b22";
  ctx.globalAlpha = a.state === "offline" ? 0.45 : 1;

  // bayangan
  ctx.fillStyle = "rgba(20,15,25,.25)"; ctx.beginPath(); ctx.ellipse(x, y, 11, 4.5, 0, 0, Math.PI * 2); ctx.fill();

  const lift = seated ? 3 : 0;
  // kaki
  if (!seated) {
    const step = moving ? Math.sin(t / 95 + a.bob) * 2.2 : 0;
    ctx.fillStyle = L.pants; ctx.strokeStyle = O; ctx.lineWidth = 1.2;
    ctx.fillRect(x - 6, y - 13 + step * 0.4, 5, 12); ctx.strokeRect(x - 6, y - 13 + step * 0.4, 5, 12);
    ctx.fillRect(x + 1, y - 13 - step * 0.4, 5, 12); ctx.strokeRect(x + 1, y - 13 - step * 0.4, 5, 12);
    ctx.fillStyle = "#2a2422"; ctx.fillRect(x - 7, y - 2 + step * 0.4, 6, 3); ctx.fillRect(x + 1, y - 2 - step * 0.4, 6, 3);
  }
  const by = y - 13 - bob - lift;
  // badan
  ctx.fillStyle = L.shirt; ctx.strokeStyle = O; ctx.lineWidth = 1.2;
  roundRect(ctx, x - 8.5, by - 15, 17, 16, 4); ctx.fill(); ctx.stroke();
  if (seated) { ctx.fillStyle = L.pants; ctx.fillRect(x - 8, by - 1, 16, 4); }
  // lengan
  ctx.fillStyle = shade(L.shirt.length === 7 ? L.shirt : "#888888", 0.88);
  const typing = back && seated && a.state === "working";
  const swing = moving ? Math.sin(t / 95 + a.bob) * 2 : typing ? Math.sin(t / 70 + a.bob) * 1.2 : 0;
  ctx.fillRect(x - 11, by - 13 + swing, 3.5, 11); ctx.fillRect(x + 7.5, by - 13 - swing, 3.5, 11);
  ctx.fillStyle = L.skin; ctx.fillRect(x - 11, by - 3 + swing, 3.5, 3); ctx.fillRect(x + 7.5, by - 3 - swing, 3.5, 3);
  if (!back && L.tie) { ctx.fillStyle = L.tie; ctx.fillRect(x - 1.2, by - 14, 2.4, 9); }
  if (a.npc?.carry) { // OB bawa nampan berisi gelas
    ctx.fillStyle = "#b9bfcc"; ctx.fillRect(x - 9, by - 6, 18, 2.5);
    ctx.fillStyle = "#fbf8f1"; ctx.fillRect(x - 6, by - 11, 4, 5); ctx.fillRect(x + 2, by - 11, 4, 5);
    ctx.fillStyle = "#8a5a36"; ctx.fillRect(x - 6, by - 9, 4, 3); ctx.fillRect(x + 2, by - 9, 4, 3);
  }
  if (!back && !L.tie) { ctx.fillStyle = shade(L.shirt, 1.15); ctx.fillRect(x - 3, by - 15, 6, 2); }

  // kepala (chibi besar)
  const hy = by - 26;
  ctx.fillStyle = L.skin; ctx.strokeStyle = O;
  roundRect(ctx, x - 10, hy - 10, 20, 19, 7); ctx.fill(); ctx.stroke();
  // rambut
  ctx.fillStyle = L.hair;
  const hs = L.hairStyle;
  if (back) {
    roundRect(ctx, x - 10.5, hy - 11, 21, 17, 7); ctx.fill(); ctx.stroke();
    if (hs === "long") { ctx.fillRect(x - 9, hy + 3, 18, 9); }
    if (hs === "bun") { ctx.beginPath(); ctx.arc(x, hy - 12, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
  } else {
    if (hs === "cap") {
      ctx.fillStyle = L.cap ?? "#c0504d"; roundRect(ctx, x - 10.5, hy - 12, 21, 8, 4); ctx.fill(); ctx.stroke();
      ctx.fillRect(x + (f > 0 ? 2 : -14), hy - 6, 12, 3);
    } else {
      roundRect(ctx, x - 10.5, hy - 11.5, 21, 9, 5); ctx.fill();
      if (hs === "spiky") for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.moveTo(x - 9 + i * 5, hy - 10); ctx.lineTo(x - 7 + i * 5, hy - 15); ctx.lineTo(x - 4 + i * 5, hy - 10); ctx.fill(); }
      if (hs === "curly") for (let i = 0; i < 5; i++) { ctx.beginPath(); ctx.arc(x - 9 + i * 4.5, hy - 10, 3.2, 0, Math.PI * 2); ctx.fill(); }
      if (hs === "long") { ctx.fillRect(x - 11, hy - 6, 4, 16); ctx.fillRect(x + 7, hy - 6, 4, 16); }
      if (hs === "bun") { ctx.beginPath(); ctx.arc(x + 3 * f, hy - 13, 4.5, 0, Math.PI * 2); ctx.fill(); }
      if (hs === "neat") { ctx.fillStyle = shade(L.hair, 1.6); ctx.fillRect(x - 3 * f, hy - 10, 6 * f, 1.5); }
      ctx.fillStyle = L.hair; ctx.fillRect(x + (f > 0 ? -10.5 : 6.5), hy - 6, 4, 6);
    }
    // wajah
    const ex = x + f * 1.5;
    ctx.fillStyle = "#1d1b22"; ctx.fillRect(ex - 5, hy, 2.4, 3.2); ctx.fillRect(ex + 2.6, hy, 2.4, 3.2);
    ctx.fillStyle = "#fff"; ctx.fillRect(ex - 4.4, hy + 0.4, 1, 1); ctx.fillRect(ex + 3.2, hy + 0.4, 1, 1);
    if (L.glasses) { ctx.strokeStyle = "#2b2b33"; ctx.lineWidth = 1; ctx.strokeRect(ex - 6.5, hy - 1, 5.5, 5); ctx.strokeRect(ex + 1, hy - 1, 5.5, 5); }
    ctx.fillStyle = "rgba(232,110,110,.5)"; ctx.fillRect(ex - 8, hy + 4.5, 3, 1.6); ctx.fillRect(ex + 5, hy + 4.5, 3, 1.6);
    ctx.fillStyle = "#8a3b30"; ctx.fillRect(ex - 1, hy + 5.5, 2.5, 1);
  }
  ctx.globalAlpha = 1;
  a.screen = { x, head: hy - 16, feet: y };
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

/* ================================================================== scene */

export class FloorScene {
  private ctx: Ctx;
  private overlay: HTMLCanvasElement;
  private octx: Ctx;
  private cw = 0; private ch = 0; private dpr = 1; private scale = 1;
  private cam = { x: 0, y: 0, follow: true };
  private room: RoomId = "lobby";
  private selected: Who | null = null;
  private light: LightMode = "auto";
  private people: Person[];
  private npcs: Person[] = [];
  private boss: Person;
  data: SceneData | null = null;
  private flights: { from: Who; to: Who; start: number }[] = [];
  private raf = 0;
  private last = performance.now();
  private down: { x: number; y: number; cx: number; cy: number; moved: boolean } | null = null;
  private ro: ResizeObserver;
  private reducedMotion = false;
  private disposers: (() => void)[] = [];

  constructor(private canvas: HTMLCanvasElement, private wrap: HTMLElement, private cb: Callbacks) {
    this.ctx = canvas.getContext("2d")!;
    canvas.style.imageRendering = "auto";
    this.overlay = document.createElement("canvas");
    this.overlay.className = "floor-overlay";
    this.overlay.setAttribute("aria-hidden", "true");
    wrap.appendChild(this.overlay);
    this.octx = this.overlay.getContext("2d")!;
    this.people = ROSTER.map((d, i) => ({
      id: d.slug, nama: d.nama, jabatan: d.jabatan, color: d.shirt,
      seat: d.seat, x: d.seat[0] + 0.5, y: d.seat[1] + 0.5, path: [], target: d.seat,
      state: "idle", bubble: "", bob: i * 1.7, face: 1, look: LOOKS[d.slug],
      nextAct: performance.now() + 8000 + i * 6000 + Math.random() * 10000,
    }));
    this.boss = { id: "bos", nama: "Vivo", jabatan: "Bos", color: "#2f3a56", look: LOOKS.bos, seat: [26, 9], x: 26.5, y: 9.55, path: [], target: [26, 9], state: "working", bubble: "", bob: 0, face: 1, bos: true, nextAct: 0 };
    const npc = (id: NpcId, nama: string, jabatan: string, color: string, look: Look, start: Cell, n: NonNullable<Person["npc"]>): Person => ({
      id, nama, jabatan, color, look, seat: start, x: start[0] + 0.5, y: start[1] + 0.5, path: [], target: start,
      state: "working", bubble: "", bob: Math.random() * 6, face: 1, nextAct: performance.now() + 2000 + Math.random() * 4000, npc: n,
    });
    this.npcs = [
      npc("ob", "Ujang", "OB", "#6c8ebf", NPC_LOOKS.ob, [6, 5], {
        kind: "human", carry: true, speed: 1.8, pauseMin: 2500, pauseMax: 6000,
        route: [[6, 5], [11, 4], [15, 4], [20, 5], [24, 5], [27, 5], [26, 8], [24, 11], [27, 17], [21, 17], [15, 19], [9, 17], [3, 16], [5, 13], [3, 8], [4, 5]],
      }),
      npc("satpam", "Pak Budi", "Satpam", "#3b4a6b", NPC_LOOKS.satpam, [6, 6], {
        kind: "human", speed: 1.2, pauseMin: 9000, pauseMax: 18000, route: [[6, 6], [3, 6], [6, 5], [7, 3]],
      }),
      npc("scalper", "Dimas", "Trader 1h", "#ff9f43", NPC_LOOKS.scalper, [32, 4], {
        kind: "human", speed: 1.4, pauseMin: 9000, pauseMax: 22000, route: [[32, 4], [34, 8], [32, 8], [34, 4], [33, 10]],
      }),
      npc("kucing", "Mochi", "Kucing kantor", "#e8a04b", NPC_LOOKS.ob, [18, 10], {
        kind: "cat", speed: 1.6, pauseMin: 6000, pauseMax: 16000, route: [[18, 10], [19, 11], [22, 9], [18, 13], [24, 9], [21, 11], [17, 12]],
      }),
    ];
    this.reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(wrap);
    this.resize();
    const v = this.roomView(ROOMS[0]!); this.cam.x = v.x; this.cam.y = v.y; this.scale = v.s;
    this.bindPointer();
    this.raf = requestAnimationFrame(this.frame);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.disposers.forEach(d => d());
    this.overlay.remove();
  }

  setRoom(id: RoomId) { this.room = id; this.cam.follow = true; }
  setSelected(who: Who | null) { this.selected = who; }
  setLight(mode: LightMode) { this.light = mode; }
  isNight() { const h = jktHour(); return this.light === "malam" || (this.light === "auto" && (h >= 18 || h < 6)); }

  setData(d: SceneData, opts: { snap?: boolean } = {}) {
    const first = this.data === null;
    this.data = d;
    for (const p of this.people) {
      const a = d.agents.find(x => x.slug === p.id);
      if (!a) continue;
      const changed = p.state !== a.state;
      const fresh = !p.placed;
      p.state = a.state; p.bubble = a.bubble;
      if (changed || first || fresh) {
        p.errand = null;
        p.placed = true;
        p.target = this.targetFor(p);
        if (first || fresh || opts.snap || this.reducedMotion) { p.x = p.target[0] + 0.5; p.y = p.target[1] + 0.5; p.path = []; }
        else p.path = findPath(Math.floor(p.x), Math.floor(p.y), p.target[0], p.target[1]);
      }
    }
  }

  flyMessage(from: Who, to: Who) {
    if (this.reducedMotion || from === to) return;
    if (this.flights.length > 12) this.flights.shift();
    this.flights.push({ from, to, start: performance.now() });
  }

  /** Perilaku "hidup": jalan sebentar dari meja, jalan-jalan saat idle, NPC keliling. Murni visual. */
  private behave(now: number) {
    if (this.reducedMotion) return;
    const cell = (a: Person): Cell => [Math.floor(a.x), Math.floor(a.y)];
    const busy = new Set(this.people.flatMap(p => [key(...p.target), p.errand ? key(...p.errand.spot) : ""]));
    for (const a of this.people) {
      if (a.path.length) continue;
      if (a.errand) {
        const e = a.errand;
        if (e.phase === "go") { e.phase = "stay"; e.until = now + 4000 + Math.random() * 5000; a.emote = { text: e.emote, until: e.until }; }
        else if (e.phase === "stay" && now > e.until) { e.phase = "back"; a.path = findPath(...cell(a), a.target[0], a.target[1]); }
        else if (e.phase === "back") { a.errand = null; a.nextAct = now + 40000 + Math.random() * 70000; }
        continue;
      }
      if (now < a.nextAct) continue;
      if (a.state === "working") {
        const opts = ERRANDS.filter(o => !busy.has(key(...o.spot)));
        const pick = opts[Math.floor(Math.random() * opts.length)];
        const path = pick ? findPath(...cell(a), pick.spot[0], pick.spot[1]) : [];
        if (pick && path.length) { a.path = path; a.errand = { spot: pick.spot, phase: "go", until: 0, emote: pick.emote }; busy.add(key(...pick.spot)); }
        else a.nextAct = now + 30000;
      } else if (a.state === "idle") {
        const free = IDLE_SPOTS.filter(s => !busy.has(key(...s)));
        const s = free[Math.floor(Math.random() * free.length)];
        if (s) { busy.delete(key(...a.target)); a.target = s; busy.add(key(...s)); a.path = findPath(...cell(a), s[0], s[1]); }
        if (Math.random() < 0.35) a.emote = { text: ["☕", "😌", "🎵", "💬"][Math.floor(Math.random() * 4)]!, until: now + 3500 };
        a.nextAct = now + 9000 + Math.random() * 9000;
      } else {
        a.nextAct = now + 15000;
      }
    }
    for (const n of this.npcs) {
      if (n.path.length || now < n.nextAct || !n.npc) continue;
      const r = n.npc.route;
      const options = r.filter(c => key(...c) !== key(...cell(n)));
      const next = n.npc.kind === "human" && n.id === "ob"
        ? r[(r.findIndex(c => key(...c) === key(...n.target)) + 1) % r.length]!
        : options[Math.floor(Math.random() * options.length)]!;
      n.target = next;
      n.path = findPath(...cell(n), next[0], next[1]);
      n.nextAct = now + n.npc.pauseMin + Math.random() * (n.npc.pauseMax - n.npc.pauseMin);
      if (n.npc.kind === "cat" && Math.random() < 0.4) n.emote = { text: "🐾", until: now + 2500 };
    }
  }

  private targetFor(a: Person): Cell {
    if (a.state === "meeting") {
      const taken = this.people.filter(o => o !== a && o.state === "meeting").map(o => key(...o.target));
      return MEETING_SEATS.find(s => !taken.includes(key(...s))) ?? MEETING_SEATS[0]!;
    }
    if (a.state === "idle") {
      const taken = this.people.filter(o => o !== a && o.state === "idle").map(o => key(...o.target));
      const free = IDLE_SPOTS.filter(s => !taken.includes(key(...s)));
      return free[(a.id.charCodeAt(0) + a.id.length) % Math.max(1, free.length)] ?? IDLE_SPOTS[0]!;
    }
    return a.seat;
  }

  /** "back" = duduk membelakangi kamera (kerja di meja), "front" = duduk menghadap kamera, null = berdiri. */
  private seatMode(a: Person): "back" | "front" | null {
    if (a.bos || a.npc || a.path.length) return null;
    const gx = Math.floor(a.x), gy = Math.floor(a.y);
    if (gx === a.seat[0] && gy === a.seat[1] && (a.state === "working" || a.state === "waiting_approval" || a.state === "alert")) return "back";
    if (a.state === "meeting" && MEETING_SEATS.some(([sx, sy]) => sx === gx && sy === gy)) return gy === 9 ? "front" : "back";
    return null;
  }

  private resize() {
    const r = this.wrap.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1; this.cw = r.width; this.ch = r.height;
    // Resolusi penuh layar (termasuk HiDPI) supaya tajam, tidak buram saat zoom out.
    this.canvas.width = Math.max(1, Math.round(this.cw * this.dpr)); this.canvas.height = Math.max(1, Math.round(this.ch * this.dpr));
    this.overlay.width = Math.round(this.cw * this.dpr); this.overlay.height = Math.round(this.ch * this.dpr);
  }

  private roomView(r: Room) {
    const c = iso((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2, 30);
    const w = ((r.x1 - r.x0) + (r.y1 - r.y0)) * TW / 2;
    const h = ((r.x1 - r.x0) + (r.y1 - r.y0)) * TH / 2 + 130;
    const s = Math.max(0.5, Math.min(1.7, Math.min(this.cw / (w * 1.05), this.ch / (h * 1.0))));
    return { x: c.x, y: c.y, s };
  }

  private toScreen(p: P): P { return { x: (p.x - this.cam.x) * this.scale + this.cw / 2, y: (p.y - this.cam.y) * this.scale + this.ch / 2 }; }

  /* ---------------------------------------------------------------- walls */
  private drawWalls(ctx: Ctx, night: boolean, t: number) {
    // lantai luar & dinding belakang (tebal)
    poly(ctx, [iso(0, 0, WALL), iso(GW, 0, WALL), iso(GW, 0, 0), iso(0, 0, 0)], "#efe6d6");
    poly(ctx, [iso(0, 0, WALL), iso(0, GH, WALL), iso(0, GH, 0), iso(0, 0, 0)], "#ded2bd");
    // panel dekoratif bawah
    poly(ctx, [iso(0, 0, 14), iso(GW, 0, 14), iso(GW, 0, 0), iso(0, 0, 0)], "#c9b597");
    poly(ctx, [iso(0, 0, 14), iso(0, GH, 14), iso(0, GH, 0), iso(0, 0, 0)], "#b8a385");
    // aksen warna per ruang di dinding belakang
    const accent: [number, number, string][] = [[8, 16, "#5c7a8f"], [23, 30, "#4a4458"]];
    for (const [a, b, c] of accent) poly(ctx, [iso(a, 0, WALL), iso(b, 0, WALL), iso(b, 0, 14), iso(a, 0, 14)], c);
    poly(ctx, [iso(0, 7, WALL), iso(0, 15, WALL), iso(0, 15, 14), iso(0, 7, 14)], "#6d5a7e");
    poly(ctx, [iso(0, 15, WALL), iso(0, GH, WALL), iso(0, GH, 14), iso(0, 15, 14)], "#34404f");
    // tutup atas dinding
    poly(ctx, [iso(0, 0, WALL), iso(GW, 0, WALL), iso(GW, -0.25, WALL), iso(-0.25, -0.25, WALL), iso(-0.25, GH, WALL), iso(0, GH, WALL)], "#7a6a55");

    for (const w of windows) this.drawWindow(ctx, w.ax, w.a, w.b, night, t, w.seed);
    for (const s of screens) {
      const w = (s.b - s.a) * 32, h = s.z1 - s.z0;
      const frame = () => { ctx.fillStyle = "#1c2131"; ctx.fillRect(-3, -3, w + 6, h + 6); ctx.fillStyle = "#0e1220"; ctx.fillRect(0, 0, w, h); ctx.beginPath(); ctx.rect(0, 0, w, h); ctx.clip(); s.draw(ctx, w, h, t, this); };
      if (s.ax === "x") onFaceY(ctx, s.a, 0, s.z1, frame); else onFaceX(ctx, 0, s.b, s.z1, frame);
    }
  }

  private drawWindow(ctx: Ctx, ax: "x" | "y", a: number, b: number, night: boolean, t: number, seed: number) {
    const w = (b - a) * 32, h = 78;
    const draw = () => {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      if (night) { g.addColorStop(0, "#141b3d"); g.addColorStop(1, "#3a3260"); } else { g.addColorStop(0, "#8fc7ea"); g.addColorStop(1, "#d9eef7"); }
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      // gedung kota
      const n = Math.max(3, Math.round(w / 9));
      for (let i = 0; i < n; i++) {
        const bw = 6 + rand(seed + i) * 7, bh = 22 + rand(seed + i * 5) * 46;
        const bx = (i / n) * w - 2;
        ctx.fillStyle = night ? (i % 2 ? "#232a4f" : "#1b2142") : (i % 2 ? "#7d97ad" : "#9cb2c4");
        ctx.fillRect(bx, h - bh, bw, bh);
        for (let r = 0; r < bh / 6 - 1; r++) for (let c = 0; c < bw / 3 - 1; c++) {
          const on = rand(seed * 13 + i * 31 + r * 7 + c) > (night ? 0.45 : 0.8);
          if (!on) continue;
          ctx.globalAlpha = night ? 0.7 + 0.3 * Math.sin(t / 1100 + i + r) : 0.5;
          ctx.fillStyle = night ? "#ffd27a" : "#e8f4fb";
          ctx.fillRect(bx + 1.5 + c * 3, h - bh + 3 + r * 6, 1.5, 2);
        }
        ctx.globalAlpha = 1;
      }
      // bingkai & mullion
      ctx.strokeStyle = "#5a5f6e"; ctx.lineWidth = 3; ctx.strokeRect(0, 0, w, h);
      ctx.lineWidth = 2; for (let k = 1; k < Math.round(w / 32); k++) { ctx.beginPath(); ctx.moveTo(k * w / Math.round(w / 32), 0); ctx.lineTo(k * w / Math.round(w / 32), h); ctx.stroke(); }
      ctx.fillStyle = "rgba(255,255,255,.12)"; ctx.beginPath(); ctx.moveTo(4, h); ctx.lineTo(18, 0); ctx.lineTo(26, 0); ctx.lineTo(12, h); ctx.fill();
    };
    if (ax === "x") onFaceY(ctx, a, 0, 94, draw); else onFaceX(ctx, 0, b, 94, draw);
  }

  /* ---------------------------------------------------------------- floors */
  private drawFloors(ctx: Ctx) {
    const floorOf = (id: RoomId): { base: string; kind: "wood" | "tile" | "carpet" | "dark" } => ({
      lobby: { base: "#c99a66", kind: "wood" as const },
      riset: { base: "#b98a5c", kind: "wood" as const },
      risk: { base: "#c6ced8", kind: "tile" as const },
      exec: { base: "#4a4f60", kind: "dark" as const },
      meeting: { base: "#8a7a9e", kind: "carpet" as const },
      jurnal: { base: "#a8764c", kind: "wood" as const },
      lounge: { base: "#e4dccb", kind: "tile" as const },
      bos: { base: "#7a4f34", kind: "wood" as const },
      ops: { base: "#3d4252", kind: "dark" as const },
      regime: { base: "#b9c4d0", kind: "tile" as const },
      berita: { base: "#a97a52", kind: "wood" as const },
      lab: { base: "#e6eaee", kind: "tile" as const },
      review: { base: "#8d6a4a", kind: "wood" as const },
      scalp: { base: "#2c3140", kind: "dark" as const },
    })[id];
    for (const r of ROOMS) {
      const f = floorOf(r.id);
      for (let x = r.x0; x < r.x1; x++) for (let y = r.y0; y < r.y1; y++) {
        let c = f.base;
        if (f.kind === "tile" || f.kind === "dark") c = shade(f.base, (x + y) % 2 ? 1 : 0.94);
        if (f.kind === "carpet") c = shade(f.base, 0.97 + rand(x * 7 + y) * 0.06);
        poly(ctx, [iso(x, y), iso(x + 1, y), iso(x + 1, y + 1), iso(x, y + 1)], c);
        if (f.kind === "wood") {
          ctx.strokeStyle = shade(f.base, 0.8); ctx.lineWidth = 1;
          for (let k = 0; k < 4; k++) {
            const a = iso(x, y + k / 4), b = iso(x + 1, y + k / 4);
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
            const sx = x + ((k * 0.37 + rand(x * 3 + y * 11 + k)) % 1);
            const s0 = iso(sx, y + k / 4), s1 = iso(sx, y + (k + 1) / 4);
            ctx.beginPath(); ctx.moveTo(s0.x, s0.y); ctx.lineTo(s1.x, s1.y); ctx.stroke();
          }
        }
        if (f.kind === "dark") { ctx.strokeStyle = "rgba(99,199,178,.18)"; ctx.lineWidth = 1; const a = iso(x, y), b = iso(x + 1, y), c2 = iso(x, y + 1); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.moveTo(a.x, a.y); ctx.lineTo(c2.x, c2.y); ctx.stroke(); }
      }
    }
    // tepi bangunan
    poly(ctx, [iso(0, GH), iso(GW, GH), iso(GW, GH, -10), iso(0, GH, -10)], "#5a4a3a");
    poly(ctx, [iso(GW, 0), iso(GW, GH), iso(GW, GH, -10), iso(GW, 0, -10)], "#47392c");
  }

  /* ---------------------------------------------------------------- dipanggil dari items */
  drawEasel(ctx: Ctx, gx: number, gy: number) {
    const d = this.data;
    const p = iso(gx, gy);
    ctx.fillStyle = "#5b4330"; ctx.fillRect(p.x - 10, p.y - 40, 2, 40); ctx.fillRect(p.x + 8, p.y - 40, 2, 40);
    const w = 70, h = 56, x = p.x - w / 2, y = p.y - 40 - h;
    ctx.fillStyle = "#3a2a1c"; ctx.fillRect(x - 2, y - 2, w + 4, h + 4);
    ctx.fillStyle = "#f6f1e5"; ctx.fillRect(x, y, w, h);
    px(ctx, d?.journalLine ? "JURNAL LIVE" : "JURNAL", x + 4, y + 9, 7, "#2a2d3a");
    if (d?.journalLine) px(ctx, d.journalLine, x + 4, y + h - 4, 5.5, "#3e6b4a", 500);
    const rows = (d?.board ?? []).slice(0, 4);
    const maxV = Math.max(10, ...rows.map(r => Math.abs(r.ret ?? 0)));
    rows.forEach((r, i) => {
      const yy = y + 14 + i * 10;
      px(ctx, r.label.split(" ")[0]!.slice(0, 4), x + 3, yy + 6, 6, "#2a2d3a", 500);
      const len = Math.max(1, Math.abs(r.ret ?? 0) / maxV * (w - 30));
      ctx.fillStyle = (r.ret ?? 0) < 0 ? "#d24d3b" : "#3e9e62"; ctx.fillRect(x + 26, yy, len, 5);
      if (r.hold != null) { ctx.fillStyle = "#9a9db0"; ctx.fillRect(x + 26, yy + 6, Math.min(w - 30, Math.abs(r.hold) / maxV * (w - 30)), 1.5); }
    });
    if (!rows.length) px(ctx, "belum ada scan", x + 4, y + 26, 6, "#5a5d6a", 500);
  }

  drawEquityBoard(ctx: Ctx, t: number) {
    const e = this.data?.eq;
    // kaki & rangka
    isoBox(ctx, 23.4, 7.35, 23.5, 7.45, 0, 26, "#2a2f3c", { outline: false });
    isoBox(ctx, 25.6, 7.35, 25.7, 7.45, 0, 26, "#2a2f3c", { outline: false });
    isoBox(ctx, 23.2, 7.25, 25.9, 7.45, 26, 74, "#1c2131");
    onFaceY(ctx, 23.3, 7.45, 96, () => {
      const w = 2.5 * 32, h = 66;
      ctx.fillStyle = "#0b1020"; ctx.fillRect(0, 0, w, h);
      px(ctx, "EQUITY LIVE", 4, 9, 7.5, "#f0b44c");
      if (!e || e.last == null) { px(ctx, "menunggu data bot", 4, 26, 6.5, "#a4a9bd", 500); return; }
      ctx.fillStyle = e.mode === "LIVE" ? "#ef6b57" : "#63c7b2"; ctx.globalAlpha = 0.6 + 0.4 * Math.sin(t / 400); ctx.beginPath(); ctx.arc(w - 6, 6, 2, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
      px(ctx, `$${fmt(e.last)}`, 4, 22, 11, "#ece6d8");
      const up = (e.change ?? 0) >= 0;
      const c = up ? "#4fd18b" : "#ef6b57";
      if (e.change != null) px(ctx, `${up ? "▲" : "▼"} ${up ? "+" : "-"}$${fmt(Math.abs(e.change))} ${e.changePct != null ? `(${up ? "+" : ""}${e.changePct.toFixed(1)}%)` : ""}`, 4, 31, 6.5, c, 500);
      // sparkline equity
      const s = e.series;
      const top = 35, bh = 18;
      if (s.length > 1) {
        const mn = Math.min(...s), mx = Math.max(...s), sp = mx - mn || 1;
        const trend = s.at(-1)! >= s[0]! ? "#4fd18b" : "#ef6b57";
        ctx.beginPath();
        s.forEach((v, i) => { const X = 4 + (i / (s.length - 1)) * (w - 8), Y = top + (1 - (v - mn) / sp) * bh; if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y); });
        ctx.strokeStyle = trend; ctx.lineWidth = 1.2; ctx.stroke();
        ctx.lineTo(w - 4, top + bh); ctx.lineTo(4, top + bh); ctx.closePath();
        ctx.globalAlpha = 0.18; ctx.fillStyle = trend; ctx.fill(); ctx.globalAlpha = 1;
        const lx = w - 4, ly = top + (1 - (s.at(-1)! - mn) / sp) * bh;
        ctx.fillStyle = trend; ctx.globalAlpha = 0.6 + 0.4 * Math.sin(t / 300); ctx.fillRect(lx - 1.5, ly - 1.5, 3, 3); ctx.globalAlpha = 1;
      }
      // bar pendapatan harian
      const d = e.daily.slice(-10);
      const dm = Math.max(0.01, ...d.map(Math.abs));
      const mid = 60, bw = (w - 8) / Math.max(10, d.length);
      ctx.fillStyle = "#2a3150"; ctx.fillRect(4, mid, w - 8, 0.6);
      d.forEach((v, i) => { const hh = Math.max(0.6, Math.abs(v) / dm * 5); ctx.fillStyle = v >= 0 ? "#4fd18b" : "#ef6b57"; ctx.fillRect(4 + i * bw + 0.5, v >= 0 ? mid - hh : mid + 0.6, bw - 1, hh); });
      if (e.floating != null) px(ctx, `float ${e.floating >= 0 ? "+" : "-"}$${fmt(Math.abs(e.floating))}`, w - 42, 31, 5.5, e.floating >= 0 ? "#4fd18b" : "#ef6b57", 500);
    });
  }

  drawTray(ctx: Ctx, gx: number, gy: number) {
    const pend = this.data?.pendingCount ?? 0;
    isoBox(ctx, gx - 0.25, gy - 0.15, gx + 0.25, gy + 0.15, 22, 3, "#e9e1cf");
    if (pend) {
      const p = iso(gx, gy, 25);
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 260);
      ctx.fillStyle = `rgba(243,210,91,${0.3 + 0.4 * pulse})`;
      ctx.beginPath(); ctx.ellipse(p.x, p.y, 18, 9, 0, 0, Math.PI * 2); ctx.fill();
      for (let i = 0; i < Math.min(pend, 4); i++) isoBox(ctx, gx - 0.18, gy - 0.1, gx + 0.18, gy + 0.1, 25 + i * 1.5, 1.2, "#fbf8f1");
    }
  }

  private drawLamp(ctx: Ctx, t: number) {
    const p = iso(28.5, 1.5, 56);
    const open = (this.data?.positions.length ?? 0) > 0;
    const on = open && Math.floor(t / 450) % 2 === 0;
    ctx.fillStyle = on ? "#ff3b2f" : "#6b3a36";
    ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#1d1b22"; ctx.lineWidth = 1.2; ctx.stroke();
    if (on) { ctx.fillStyle = "rgba(255,59,47,.28)"; ctx.beginPath(); ctx.arc(p.x, p.y, 18, 0, Math.PI * 2); ctx.fill(); }
  }

  /* ---------------------------------------------------------------- overlay (tajam, ruang layar) */
  private drawOverlay(t: number) {
    const o = this.octx, dpr = this.dpr;
    o.setTransform(dpr, 0, 0, dpr, 0, 0);
    o.clearRect(0, 0, this.cw, this.ch);
    o.textBaseline = "middle";

    // label ruang
    for (const r of ROOMS) {
      const s = this.toScreen(iso(r.x0 + 0.4, r.y1 - 0.4));
      if (s.x < -100 || s.y < -20 || s.x > this.cw + 20 || s.y > this.ch + 20) continue;
      o.font = `700 12px "Pixelify Sans", monospace`;
      const w = o.measureText(r.name).width + 14;
      const sel = r.id === this.room;
      o.fillStyle = sel ? "rgba(240,180,76,.95)" : "rgba(20,24,36,.7)";
      roundRect(o, s.x - 6, s.y - 10, w, 20, 4); o.fill();
      o.fillStyle = sel ? "#2a1d05" : "#ece6d8"; o.fillText(r.name, s.x + 1, s.y + 0.5);
    }

    const far = this.scale < FAR_ZOOM;
    for (const n of this.npcs) { // NPC: tag kecil abu-abu, tanpa bubble status
      if (!n.screen) continue;
      if (far) continue;
      const feet = this.toScreen({ x: n.screen.x, y: n.screen.feet });
      o.font = `500 10px "IBM Plex Sans", sans-serif`;
      const label = `${n.nama} · ${n.jabatan}`;
      const tw = o.measureText(label).width + 12;
      o.fillStyle = "rgba(20,24,36,.55)"; roundRect(o, feet.x - tw / 2, feet.y + 4, tw, 15, 7.5); o.fill();
      o.fillStyle = "#cfd2de"; o.fillText(label, feet.x - tw / 2 + 6, feet.y + 12);
      this.emoteAt(o, n, t);
    }

    const everyone = [...this.people, this.boss].sort((p, q) => (p.x + p.y) - (q.x + q.y));
    for (const a of everyone) {
      if (!a.screen) continue;
      const feet = this.toScreen({ x: a.screen.x, y: a.screen.feet });
      const head = this.toScreen({ x: a.screen.x, y: a.screen.head });
      const sel = this.selected === a.id;
      this.emoteAt(o, a, t);

      // name tag: titik warna + nama + jabatan (kecil, seperti di video)
      o.font = `600 11px "IBM Plex Sans", sans-serif`;
      const nm = a.nama, jb = far ? "" : a.jabatan;
      const w1 = o.measureText(nm).width;
      o.font = `500 10px "IBM Plex Sans", sans-serif`;
      const w2 = o.measureText(jb).width;
      const tw = 8 + 8 + w1 + 5 + w2 + 8;
      const ty = feet.y + 12;
      o.fillStyle = sel ? "#f0b44c" : "rgba(20,24,36,.88)";
      roundRect(o, feet.x - tw / 2, ty - 9, tw, 18, 9); o.fill();
      o.fillStyle = a.color; o.beginPath(); o.arc(feet.x - tw / 2 + 10, ty, 3.5, 0, Math.PI * 2); o.fill();
      o.fillStyle = sel ? "#2a1d05" : "#ffffff"; o.font = `600 11px "IBM Plex Sans", sans-serif`; o.fillText(nm, feet.x - tw / 2 + 18, ty + 0.5);
      o.fillStyle = sel ? "#4a3510" : "#a4a9bd"; o.font = `500 10px "IBM Plex Sans", sans-serif`; o.fillText(jb, feet.x - tw / 2 + 18 + w1 + 5, ty + 0.5);

      if (a.bos) {
        const pend = this.data?.pendingCount ?? 0;
        if (pend) this.badge(o, head.x, head.y - 8, t, String(pend));
        continue;
      }
      if (!a.bubble) continue;
      if (far) { // zoom jauh: cukup tanda ! untuk yang butuh perhatian
        if (a.state === "waiting_approval" || a.state === "alert") this.badge(o, head.x, head.y - 4, t);
        continue;
      }
      // pill status satu baris: ikon + teks
      o.font = `500 11px "IBM Plex Sans", sans-serif`;
      const maxW = 190;
      let text = a.bubble;
      if (o.measureText(text).width > maxW) { while (text.length > 2 && o.measureText(text + "…").width > maxW) text = text.slice(0, -1); text += "…"; }
      const bw = o.measureText(text).width + 30, bh = 22;
      const bx = head.x - bw / 2, byy = head.y - bh - 6;
      const border = a.state === "waiting_approval" ? "#f3d25b" : a.state === "alert" ? "#ef6b57" : a.state === "meeting" ? "#63c7b2" : "rgba(0,0,0,.12)";
      o.shadowColor = "rgba(0,0,0,.25)"; o.shadowBlur = 6; o.shadowOffsetY = 2;
      o.fillStyle = "#fbf8f1"; roundRect(o, bx, byy, bw, bh, 11); o.fill();
      o.shadowColor = "transparent"; o.shadowBlur = 0; o.shadowOffsetY = 0;
      o.strokeStyle = border; o.lineWidth = 1.5; o.stroke();
      o.beginPath(); o.moveTo(head.x - 4, byy + bh); o.lineTo(head.x, byy + bh + 5); o.lineTo(head.x + 4, byy + bh); o.closePath(); o.fillStyle = "#fbf8f1"; o.fill();
      // ikon kecil
      const ic = { x: bx + 12, y: byy + bh / 2 };
      const icc = a.state === "meeting" ? "#63c7b2" : a.state === "idle" ? "#a4a9bd" : a.state === "alert" ? "#ef6b57" : a.state === "waiting_approval" ? "#e0a92e" : "#5aa6c9";
      o.fillStyle = icc; roundRect(o, ic.x - 5, ic.y - 5, 10, 10, 2); o.fill();
      o.fillStyle = "#fff";
      if (a.state === "idle") { o.fillRect(ic.x - 2.5, ic.y - 1, 5, 3); o.fillRect(ic.x + 2.5, ic.y - 0.5, 1.5, 2); }
      else if (a.state === "meeting") { o.fillRect(ic.x - 3, ic.y - 2.5, 6, 4); o.fillRect(ic.x - 2, ic.y + 1.5, 2, 1.5); }
      else { o.fillRect(ic.x - 3, ic.y + 1, 1.5, 2); o.fillRect(ic.x - 0.75, ic.y - 1, 1.5, 4); o.fillRect(ic.x + 1.5, ic.y - 3, 1.5, 6); }
      o.fillStyle = "#24252d"; o.fillText(text, bx + 22, byy + bh / 2 + 0.5);
      if (a.state === "waiting_approval" || a.state === "alert") this.badge(o, bx + bw - 2, byy + 1, t);
    }

    // amplop terbang
    const DUR = 1300;
    this.flights = this.flights.filter(f => t - f.start < DUR);
    for (const f of this.flights) {
      const A = (f.from === "bos" ? this.boss : this.people.find(p => p.id === f.from))?.screen;
      const B = (f.to === "bos" ? this.boss : this.people.find(p => p.id === f.to))?.screen;
      if (!A || !B) continue;
      const a = this.toScreen({ x: A.x, y: A.head }), b = this.toScreen({ x: B.x, y: B.head });
      const k = (t - f.start) / DUR, e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      const x = a.x + (b.x - a.x) * e, y = a.y + (b.y - a.y) * e - Math.sin(k * Math.PI) * 70;
      o.globalAlpha = k > 0.85 ? (1 - k) / 0.15 : 1;
      o.fillStyle = "#fbf8f1"; o.strokeStyle = "#f0b44c"; o.lineWidth = 1.5;
      roundRect(o, x - 10, y - 7, 20, 14, 2); o.fill(); o.stroke();
      o.beginPath(); o.moveTo(x - 10, y - 7); o.lineTo(x, y + 1); o.lineTo(x + 10, y - 7); o.stroke();
      o.globalAlpha = 1;
    }
  }

  private emoteAt(o: Ctx, a: Person, t: number) {
    if (!a.emote || !a.screen) return;
    if (t > a.emote.until) { a.emote = null; return; }
    const h = this.toScreen({ x: a.screen.x, y: a.screen.head });
    const life = (a.emote.until - t) / 1000;
    const pop = Math.min(1, (3.5 - Math.min(3.5, life)) * 4 + 0.2);
    const x = h.x + 20, y = h.y - 2 - (1 - Math.min(1, life)) * 6;
    o.globalAlpha = Math.min(1, life * 2);
    o.fillStyle = "#fbf8f1"; o.beginPath(); o.arc(x, y, 11 * pop, 0, Math.PI * 2); o.fill();
    o.strokeStyle = "rgba(0,0,0,.15)"; o.lineWidth = 1; o.stroke();
    o.font = `${Math.round(13 * pop)}px "Segoe UI Emoji", "Apple Color Emoji", system-ui, sans-serif`; o.textAlign = "center"; o.fillText(a.emote.text, x, y + 1); o.textAlign = "left";
    o.globalAlpha = 1;
  }

  private badge(o: Ctx, x: number, y: number, t: number, label = "!") {
    const r = 8 + (this.reducedMotion ? 0 : Math.sin(t / 180) * 1.2);
    o.fillStyle = "#ef4b3c"; o.beginPath(); o.arc(x, y, r, 0, Math.PI * 2); o.fill();
    o.strokeStyle = "#fff"; o.lineWidth = 1.5; o.stroke();
    o.fillStyle = "#fff"; o.font = `700 11px "IBM Plex Sans", sans-serif`; o.textAlign = "center"; o.fillText(label, x, y + 0.5); o.textAlign = "left";
  }

  /* ---------------------------------------------------------------- loop */
  private frame = (t: number) => {
    const ctx = this.ctx;
    const dt = Math.min(0.05, (t - this.last) / 1000); this.last = t;
    this.behave(t);
    for (const a of [...this.people, ...this.npcs]) {
      if (!a.path.length) continue;
      const [nx, ny] = a.path[0]!; const tx = nx + 0.5, ty = ny + 0.5;
      const dx = tx - a.x, dy = ty - a.y, d = Math.hypot(dx, dy), sp = (a.npc?.speed ?? 2.4) * dt;
      const sdx = (dx - dy); if (Math.abs(sdx) > 0.01) a.face = sdx > 0 ? 1 : -1;
      if (d <= sp) { a.x = tx; a.y = ty; a.path.shift(); } else { a.x += dx / d * sp; a.y += dy / d * sp; }
    }
    if (this.cam.follow) {
      const v = this.roomView(ROOMS.find(r => r.id === this.room)!);
      const k = this.reducedMotion ? 1 : 1 - Math.pow(0.002, dt);
      this.cam.x += (v.x - this.cam.x) * k; this.cam.y += (v.y - this.cam.y) * k; this.scale += (v.s - this.scale) * k;
    }
    const night = this.isNight();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.fillStyle = night ? "#121522" : "#232a3d"; ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const k = this.scale * this.dpr;
    ctx.setTransform(k, 0, 0, k, (this.cw / 2 - this.cam.x * this.scale) * this.dpr, (this.ch / 2 - this.cam.y * this.scale) * this.dpr);

    this.drawWalls(ctx, night, t);
    this.drawFloors(ctx);

    type It = Drawable | { depth: number; person: Person };
    const all: It[] = [...items, ...this.people.map(p => ({ depth: p.x + p.y + (this.seatMode(p) ? 0.15 : 0.3), person: p })), { depth: this.boss.x + this.boss.y - 0.1, person: this.boss }, ...this.npcs.map(n => ({ depth: n.x + n.y + 0.3, person: n }))];
    all.sort((a, b) => a.depth - b.depth);
    for (const it of all) {
      if ("person" in it) { if (it.person.npc?.kind === "cat") drawCat(ctx, it.person, t); else drawCharacter(ctx, it.person, t, this.seatMode(it.person)); }
      else it.draw(ctx, t, this);
    }
    this.drawLamp(ctx, t);

    // pencahayaan
    ctx.save();
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = night ? "#a7a6c8" : "#fff6ea"; ctx.fillRect(-5000, -5000, 10000, 10000);
    ctx.globalCompositeOperation = "lighter";
    for (const g of glows) {
      const p = iso(g.gx, g.gy, g.z); const gr = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, g.r);
      gr.addColorStop(0, g.c + (night ? "50" : "22")); gr.addColorStop(1, g.c + "00"); ctx.fillStyle = gr; ctx.fillRect(p.x - g.r, p.y - g.r, g.r * 2, g.r * 2);
    }
    ctx.restore();

    this.drawOverlay(t);
    this.raf = requestAnimationFrame(this.frame);
  };

  /* ---------------------------------------------------------------- pointer */
  private bindPointer() {
    const c = this.canvas;
    const onDown = (e: PointerEvent) => { this.down = { x: e.clientX, y: e.clientY, cx: this.cam.x, cy: this.cam.y, moved: false }; c.setPointerCapture(e.pointerId); };
    const onMove = (e: PointerEvent) => {
      if (!this.down) return;
      const dx = e.clientX - this.down.x, dy = e.clientY - this.down.y;
      if (!this.down.moved && Math.hypot(dx, dy) > 5) { this.down.moved = true; this.cam.follow = false; c.classList.add("dragging"); }
      if (this.down.moved) { this.cam.x = this.down.cx - dx / this.scale; this.cam.y = this.down.cy - dy / this.scale; }
    };
    const onUp = (e: PointerEvent) => {
      const d = this.down; this.down = null; c.classList.remove("dragging");
      if (!d || d.moved) return;
      const r = c.getBoundingClientRect();
      const wx = (e.clientX - r.left - this.cw / 2) / this.scale + this.cam.x, wy = (e.clientY - r.top - this.ch / 2) / this.scale + this.cam.y;
      const hit = [...this.people, this.boss].filter(a => a.screen && Math.abs(wx - a.screen.x) < 14 && wy > a.screen.head - 4 && wy < a.screen.feet + 6)
        .sort((p, q) => (q.x + q.y) - (p.x + p.y))[0];
      if (hit) { this.cb.onSelect(hit.id as Who); return; }
      const tray = iso(26.2, 10.5, 24);
      if (Math.hypot(wx - tray.x, wy - tray.y) < 36) { this.cb.onOpenApproval(); return; }
      const g = { x: (wx / (TW / 2) + wy / (TH / 2)) / 2, y: (wy / (TH / 2) - wx / (TW / 2)) / 2 };
      const room = roomOf(Math.floor(g.x), Math.floor(g.y));
      if (room) this.cb.onRoom(room.id);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      this.cam.follow = false;
      this.scale = Math.max(0.45, Math.min(2.6, this.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    };
    const onKey = (e: KeyboardEvent) => {
      const i = ROOMS.findIndex(r => r.id === this.room);
      if (e.key === "ArrowRight") this.cb.onRoom(ROOMS[(i + 1) % ROOMS.length]!.id);
      if (e.key === "ArrowLeft") this.cb.onRoom(ROOMS[(i + ROOMS.length - 1) % ROOMS.length]!.id);
    };
    c.addEventListener("pointerdown", onDown);
    c.addEventListener("pointermove", onMove);
    c.addEventListener("pointerup", onUp);
    c.addEventListener("wheel", onWheel, { passive: false });
    c.addEventListener("keydown", onKey);
    this.disposers.push(() => {
      c.removeEventListener("pointerdown", onDown);
      c.removeEventListener("pointermove", onMove);
      c.removeEventListener("pointerup", onUp);
      c.removeEventListener("wheel", onWheel);
      c.removeEventListener("keydown", onKey);
    });
  }
}
