import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";
import { addSample, getRagDocumentDetail } from "@/lib/rag-manage";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;
  const docId = parseInt((await params).id, 10);
  if (!Number.isFinite(docId)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  const b = await request.json().catch(() => ({}));
  const text = typeof b.text === "string" ? b.text : "";
  if (!text.trim()) return NextResponse.json({ error: "A sample can't be empty." }, { status: 400 });
  try {
    await addSample(docId, text);
    return NextResponse.json({ document: await getRagDocumentDetail(docId) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
