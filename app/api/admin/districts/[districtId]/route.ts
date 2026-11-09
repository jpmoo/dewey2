import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";
import { deleteDistrict, getDistricts, logUserEvent, setDistrictEmailDomains } from "@/lib/db";

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

/**
 * Set a district's sign-up email domains. Body: { email_domains: string[] }.
 * New Google accounts whose email is on one of them join this district.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ districtId: string }> }
) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  const id = parseInt((await params).districtId, 10);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "Invalid district id" }, { status: 400 });
  }
  const body = await request.json().catch(() => ({}));
  if (!Array.isArray(body.email_domains)) {
    return NextResponse.json({ error: "email_domains must be a list" }, { status: 400 });
  }
  try {
    const district = await setDistrictEmailDomains(id, body.email_domains.map(String));
    const adminId = Number(session.user.id);
    await logUserEvent({
      userId: adminId,
      actorId: adminId,
      action: "district_updated",
      detail: `email domains: ${district.email_domains.join(", ") || "none"}`,
      entityType: "district",
      entityId: id,
      entityLabel: district.name,
    });
    return NextResponse.json({ district });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to update district" },
      { status: 400 }
    );
  }
}
