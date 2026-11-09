import { NextResponse } from "next/server";
import { KillSwitchBodySchema } from "@/lib/office/schemas";
import { activateKillSwitch } from "@/lib/office/writes";

export const runtime = "nodejs";

// Hanya MEMBUAT execution/STOP. Sengaja tidak ada endpoint untuk menghapusnya:
// menyalakan bot lagi adalah keputusan manual Vivo.
export async function POST(req: Request) {
  const parsed = KillSwitchBodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Konfirmasi tidak valid" }, { status: 400 });
  try {
    return NextResponse.json({ ok: true, ...activateKillSwitch() });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
