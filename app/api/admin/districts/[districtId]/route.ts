import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";
import {
  deleteDistrict,
  getDistricts,
  logUserEvent,
  setDistrictCanvasInstruction,
  setDistrictEmailDomains,
} from "@/lib/db";

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
 * Update a district's settings. Body: { email_domains?: string[] } (new Google
 * accounts on these domains join this district) and/or { canvas_instruction?:
 * string } (appended to every canvas assistant request in the district).
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
  const hasDomains = "email_domains" in body;
  const hasInstruction = "canvas_instruction" in body;
  if (hasDomains && !Array.isArray(body.email_domains)) {
    return NextResponse.json({ error: "email_domains must be a list" }, { status: 400 });
  }
  if (hasInstruction && typeof body.canvas_instruction !== "string") {
    return NextResponse.json({ error: "canvas_instruction must be text" }, { status: 400 });
  }
  if (!hasDomains && !hasInstruction) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }
  try {
    let district = null as Awaited<ReturnType<typeof setDistrictEmailDomains>> | null;
    const changes: string[] = [];
    if (hasDomains) {
      district = await setDistrictEmailDomains(id, body.email_domains.map(String));
      changes.push(`email domains: ${district.email_domains.join(", ") || "none"}`);
    }
    if (hasInstruction) {
      district = await setDistrictCanvasInstruction(id, body.canvas_instruction);
      changes.push(district.canvas_instruction ? "canvas instruction updated" : "canvas instruction cleared");
    }
    const adminId = Number(session.user.id);
    await logUserEvent({
      userId: adminId,
      actorId: adminId,
      action: "district_updated",
      detail: changes.join("; "),
      entityType: "district",
      entityId: id,
      entityLabel: district?.name ?? null,
    });
    return NextResponse.json({ district });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to update district" },
      { status: 400 }
    );
  }
}
