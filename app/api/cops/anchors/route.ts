import { NextResponse } from "next/server";
import { requireCoachOrAdmin } from "@/lib/guard";
import { getDistricts, getSchools, getUserById } from "@/lib/db";

/**
 * Districts (with their schools) a CoP can be anchored to. Admins can anchor
 * anywhere; a coach or district leader anchors within their own district.
 */
export async function GET() {
  const guard = await requireCoachOrAdmin();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  const isAdmin = session.user.system_role === "admin";

  if (isAdmin) {
    const [districts, schools] = await Promise.all([getDistricts(), getSchools()]);
    return NextResponse.json({
      districts: districts.map((d) => ({
        id: d.id,
        name: d.name,
        schools: schools.filter((s) => s.district_id === d.id).map((s) => ({ id: s.id, name: s.name })),
      })),
    });
  }

  const me = await getUserById(Number(session.user.id));
  if (!me?.district_id) return NextResponse.json({ districts: [] });
  const [districts, schools] = await Promise.all([getDistricts(), getSchools(me.district_id)]);
  const d = districts.find((x) => x.id === me.district_id);
  return NextResponse.json({
    districts: d
      ? [{ id: d.id, name: d.name, schools: schools.map((s) => ({ id: s.id, name: s.name })) }]
      : [],
  });
}
