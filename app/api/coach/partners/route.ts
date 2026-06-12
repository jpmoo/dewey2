import { NextResponse } from "next/server";
import { requireCoach } from "@/lib/guard";
import { getCoachDirectory } from "@/lib/db";

/**
 * Partner directory for the signed-in coach: partners in their school, or — for
 * a district-wide coach (no school) — across their district. Scope is derived
 * from the coach's own org assignment, never from the client.
 */
export async function GET() {
  const guard = await requireCoach();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;

  const directory = await getCoachDirectory({
    district_id: session.user.district_id ?? null,
    school_id: session.user.school_id ?? null,
  });
  return NextResponse.json(directory);
}
