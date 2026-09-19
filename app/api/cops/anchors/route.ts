import { NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import { getDistricts, getSchools, getUserById } from "@/lib/db";
import { getSystemSettings, copCreateLevels } from "@/lib/settings";

/**
 * Districts (with their schools) a CoP can be anchored to, plus which anchor
 * levels the requester may create (by role). Admins can anchor anywhere; others
 * anchor within their own district.
 */
export async function GET() {
  const guard = await requireUser();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  const isAdmin = session.user.system_role === "admin";
  const settings = await getSystemSettings();
  const allowedLevels = copCreateLevels(session.user.system_role, settings.cop_create_permissions);

  if (isAdmin) {
    const [districts, schools] = await Promise.all([getDistricts(), getSchools()]);
    return NextResponse.json({
      allowedLevels,
      districts: districts.map((d) => ({
        id: d.id,
        name: d.name,
        schools: schools.filter((s) => s.district_id === d.id).map((s) => ({ id: s.id, name: s.name })),
      })),
    });
  }

  const me = await getUserById(Number(session.user.id));
  if (!me?.district_id) return NextResponse.json({ allowedLevels, districts: [] });
  const [districts, schools] = await Promise.all([getDistricts(), getSchools(me.district_id)]);
  const d = districts.find((x) => x.id === me.district_id);
  return NextResponse.json({
    allowedLevels,
    districts: d
      ? [{ id: d.id, name: d.name, schools: schools.map((s) => ({ id: s.id, name: s.name })) }]
      : [],
  });
}
