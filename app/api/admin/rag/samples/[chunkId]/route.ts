import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";
import { deleteSample, updateSample } from "@/lib/rag-manage";

async function cid(params: Promise<{ chunkId: string }>): Promise<number | null> {
  const n = parseInt((await params).chunkId, 10);
  return Number.isFinite(n) ? n : null;
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ chunkId: string }> }) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;
  const chunkId = await cid(params);
  if (chunkId == null) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  const b = await request.json().catch(() => ({}));
  const text = typeof b.text === "string" ? b.text : "";
  try {
    const embedded = await updateSample(chunkId, text);
    return NextResponse.json({ ok: true, embedded });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ chunkId: string }> }) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;
  const chunkId = await cid(params);
  if (chunkId == null) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  await deleteSample(chunkId);
  return NextResponse.json({ ok: true });
}
