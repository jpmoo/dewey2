import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";
import { reEmbedDocument } from "@/lib/rag-manage";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;
  const docId = parseInt((await params).id, 10);
  if (!Number.isFinite(docId)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  try {
    const r = await reEmbedDocument(docId);
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Re-embed failed" }, { status: 500 });
  }
}
