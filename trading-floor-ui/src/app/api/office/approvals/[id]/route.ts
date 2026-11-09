import { NextResponse } from "next/server";
import { DecideBodySchema } from "@/lib/office/schemas";
import { decideApproval, WriteError } from "@/lib/office/writes";

export const runtime = "nodejs";

// Hanya mengubah status file approval. Tidak mengirim order, tidak memanggil exchange.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = DecideBodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Body harus { status: 'approved' | 'rejected', catatanBos? }" }, { status: 400 });
  try {
    const result = decideApproval(id, parsed.data.status, parsed.data.catatanBos);
    return NextResponse.json({ ok: true, status: result.status });
  } catch (e) {
    const code = e instanceof WriteError ? e.code : 500;
    return NextResponse.json({ error: (e as Error).message }, { status: code });
  }
}
