import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";
import { addPlacement } from "@/lib/rag-manage";
import { getRagDocumentDetail } from "@/lib/rag-manage";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;
  const docId = parseInt((await params).id, 10);
  if (!Number.isFinite(docId)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  const b = await request.json().catch(() => ({}));
  const level = b.level;
  if (!["system", "district", "school", "cop"].includes(level)) {
    return NextResponse.json({ error: "Invalid placement" }, { status: 400 });
  }
  await addPlacement(docId, {
    level,
    districtId: b.districtId != null ? Number(b.districtId) : null,
    schoolId: b.schoolId != null ? Number(b.schoolId) : null,
    copId: b.copId != null ? Number(b.copId) : null,
  });
  return NextResponse.json({ document: await getRagDocumentDetail(docId) });
}
