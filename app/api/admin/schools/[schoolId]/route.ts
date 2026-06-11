import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";
import { deleteSchool } from "@/lib/db";

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ schoolId: string }> }
) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;
  const { schoolId } = await params;
  const id = parseInt(schoolId, 10);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "Invalid school id" }, { status: 400 });
  }
  const ok = await deleteSchool(id);
  if (!ok) return NextResponse.json({ error: "School not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
