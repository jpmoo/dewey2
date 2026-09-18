import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";
import { removePlacement } from "@/lib/rag-manage";

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ placementId: string }> }) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;
  const pid = parseInt((await params).placementId, 10);
  if (!Number.isFinite(pid)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  await removePlacement(pid);
  return NextResponse.json({ ok: true });
}
