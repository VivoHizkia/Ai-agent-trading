import { NextResponse } from "next/server";
import { getPrices } from "@/lib/office/market";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ prices: await getPrices(), at: new Date().toISOString() });
}
