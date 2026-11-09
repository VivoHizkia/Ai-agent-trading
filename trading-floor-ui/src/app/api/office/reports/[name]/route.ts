import { NextResponse } from "next/server";
import { readReviewMarkdown, readScanReport } from "@/lib/office/readers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const text = readScanReport(name) ?? readReviewMarkdown(name);
  if (text == null) return NextResponse.json({ error: "Laporan tidak ditemukan" }, { status: 404 });
  return NextResponse.json({ name, text });
}
