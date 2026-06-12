import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";
import { deleteSchool, getSchools, logUserEvent } from "@/lib/db";

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ schoolId: string }> }
) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  const { schoolId } = await params;
  const id = parseInt(schoolId, 10);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "Invalid school id" }, { status: 400 });
  }
  const existing = (await getSchools()).find((s) => s.id === id);
  const ok = await deleteSchool(id);
  if (!ok) return NextResponse.json({ error: "School not found" }, { status: 404 });
  const adminId = Number(session.user.id);
  await logUserEvent({
    userId: adminId,
    actorId: adminId,
    action: "school_deleted",
    detail: existing?.name ?? undefined,
    entityType: "school",
    entityId: id,
    entityLabel: existing?.name ?? null,
  });
  return NextResponse.json({ ok: true });
}
