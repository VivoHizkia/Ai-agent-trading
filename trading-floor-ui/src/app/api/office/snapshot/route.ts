import { NextResponse } from "next/server";
import { buildSnapshot } from "@/lib/office/snapshot";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(buildSnapshot(), { headers: { "Cache-Control": "no-store" } });
}
