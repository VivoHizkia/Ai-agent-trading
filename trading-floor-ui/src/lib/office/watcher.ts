import "server-only";
import { watch, type FSWatcher } from "chokidar";
import path from "node:path";
import { exists, OFFICE_DIR } from "./fsx";

// Satu watcher untuk semua koneksi SSE. Event digabung (debounce 300ms) lalu disiarkan sebagai
// { type, paths }. Klien cukup mengambil ulang snapshot (kecil, < 500KB).

type Listener = (ev: { type: "change"; paths: string[] }) => void;

interface WatchState {
  watcher: FSWatcher | null;
  listeners: Set<Listener>;
  pending: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
}

const g = globalThis as unknown as { __tfWatch?: WatchState };

function state(): WatchState {
  if (!g.__tfWatch) g.__tfWatch = { watcher: null, listeners: new Set(), pending: new Set(), timer: null };
  return g.__tfWatch;
}

function ensureWatcher() {
  const s = state();
  if (s.watcher || !exists(OFFICE_DIR)) return;
  s.watcher = watch(OFFICE_DIR, {
    ignoreInitial: true,
    depth: 4,
    // .tmp = tulis atomik yang belum selesai; scan-*.json = file raksasa, .md pasangannya sudah cukup.
    ignored: (p: string) => p.endsWith(".tmp") || /scan-[^\\/]*\.json$/.test(p),
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
  });
  const onEvent = (p: string) => {
    s.pending.add(path.relative(OFFICE_DIR, p).split(path.sep).join("/"));
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(() => {
      const paths = [...s.pending];
      s.pending.clear();
      s.timer = null;
      for (const l of s.listeners) l({ type: "change", paths });
    }, 300);
  };
  s.watcher.on("add", onEvent).on("change", onEvent).on("unlink", onEvent).on("error", e => console.warn("[office] watcher error", e));
}

export function subscribe(l: Listener): () => void {
  const s = state();
  ensureWatcher();
  s.listeners.add(l);
  return () => {
    s.listeners.delete(l);
    if (s.listeners.size === 0 && s.watcher) {
      void s.watcher.close();
      s.watcher = null;
    }
  };
}
