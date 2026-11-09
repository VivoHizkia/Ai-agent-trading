// Format tampilan: harga en-US, persen 1 desimal, waktu HH:mm WIB.

const hm = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", hour12: false });
const dm = new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", day: "numeric", month: "short" });

export function wib(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  const today = dm.format(new Date());
  const day = dm.format(d);
  return day === today ? `${hm.format(d)} WIB` : `${day} ${hm.format(d)} WIB`;
}

export const nowWib = () => `${hm.format(new Date())} WIB`;

export function price(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "-";
  const dp = n >= 1000 ? 1 : n >= 10 ? 2 : n >= 1 ? 3 : 5;
  return n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export function usd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "-";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function pct(n: number | null | undefined, signed = false): string {
  if (n == null || !Number.isFinite(n)) return "-";
  return `${signed && n > 0 ? "+" : ""}${n.toFixed(1)}%`;
}
