import { NextResponse } from "next/server";
import { requireCoach } from "@/lib/guard";
import { getCoachesInDistrict } from "@/lib/db";

/** Other coaches in the signed-in coach's district (for the share picker). */
export async function GET() {
  const guard = await requireCoach();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  const coaches = await getCoachesInDistrict(Number(session.user.id));
  return NextResponse.json({ coaches });
}
