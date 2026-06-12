import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";
import { createDistrict, getDistricts, getSchools, logUserEvent } from "@/lib/db";

/** Districts with their schools nested — drives the org panel and user-form pickers. */
export async function GET() {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;
  const [districts, schools] = await Promise.all([getDistricts(), getSchools()]);
  const withSchools = districts.map((d) => ({
    ...d,
    schools: schools.filter((s) => s.district_id === d.id),
  }));
  return NextResponse.json({ districts: withSchools });
}

export async function POST(request: NextRequest) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  const body = await request.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "District name is required" }, { status: 400 });
  try {
    const district = await createDistrict(name);
    const adminId = Number(session.user.id);
    await logUserEvent({
      userId: adminId,
      actorId: adminId,
      action: "district_created",
      entityType: "district",
      entityId: district.id,
      entityLabel: district.name,
    });
    return NextResponse.json({ district });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to create district";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
