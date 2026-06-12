import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";
import {
  getDistricts,
  getSchools,
  getTemplate,
  getUserById,
  logUserEvent,
  restoreDistrict,
  restoreSchool,
  restoreTemplate,
  restoreUser,
  type LogEntityType,
} from "@/lib/db";

const RESTORABLE: LogEntityType[] = ["user", "template", "district", "school"];

/**
 * Recover a soft-deleted entity (user, template, district, school). Admin only.
 * Restores the row (deleted_at = NULL) and records a "restored" entry in the
 * admin's log next to the original deletion.
 */
export async function POST(request: NextRequest) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;

  const body = await request.json().catch(() => ({}));
  const entityType = body.entityType as LogEntityType;
  const entityId = Number(body.entityId);
  if (!RESTORABLE.includes(entityType) || !Number.isFinite(entityId)) {
    return NextResponse.json({ error: "Invalid entity" }, { status: 400 });
  }

  let ok = false;
  let label: string | null = null;
  switch (entityType) {
    case "user":
      ok = await restoreUser(entityId);
      label = (await getUserById(entityId))?.full_name ?? null;
      break;
    case "template":
      ok = await restoreTemplate(entityId);
      label = (await getTemplate(entityId))?.name ?? null;
      break;
    case "district":
      ok = await restoreDistrict(entityId);
      label = (await getDistricts()).find((d) => d.id === entityId)?.name ?? null;
      break;
    case "school":
      ok = await restoreSchool(entityId);
      label = (await getSchools()).find((s) => s.id === entityId)?.name ?? null;
      break;
  }

  if (!ok) return NextResponse.json({ error: "Nothing to restore" }, { status: 404 });

  const adminId = Number(session.user.id);
  await logUserEvent({
    userId: adminId,
    actorId: adminId,
    action: "restored",
    detail: `${entityType}: ${label ?? entityId}`,
    entityType,
    entityId,
    entityLabel: label,
  });
  return NextResponse.json({ ok: true });
}
