import { NextResponse } from "next/server";
import { ROSTER, type AgentSlug } from "@/lib/roster";
import { buildAgentDetail } from "@/lib/office/snapshot";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!ROSTER.some(r => r.slug === slug)) return NextResponse.json({ error: "Agent tidak dikenal" }, { status: 404 });
  return NextResponse.json(buildAgentDetail(slug as AgentSlug), { headers: { "Cache-Control": "no-store" } });
}
