import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";
import { deleteDistrict, getDistricts, logUserEvent } from "@/lib/db";

/**
 * Delete a district. Its schools cascade away (FK ON DELETE CASCADE); any users
 * pointing at it or its schools have those references set null (ON DELETE SET
 * NULL), so accounts survive — they just become unassigned.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ districtId: string }> }
) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  const { districtId } = await params;
  const id = parseInt(districtId, 10);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "Invalid district id" }, { status: 400 });
  }
  const existing = (await getDistricts()).find((d) => d.id === id);
  const ok = await deleteDistrict(id);
  if (!ok) return NextResponse.json({ error: "District not found" }, { status: 404 });
  const adminId = Number(session.user.id);
  await logUserEvent({
    userId: adminId,
    actorId: adminId,
    action: "district_deleted",
    detail: existing?.name ?? undefined,
    entityType: "district",
    entityId: id,
    entityLabel: existing?.name ?? null,
  });
  return NextResponse.json({ ok: true });
}
