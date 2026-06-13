import { NextResponse } from "next/server";
import { requireCoach } from "@/lib/guard";
import { getCoachDirectory } from "@/lib/db";

/**
 * Partner directory for the signed-in coach: partners who share at least one of
 * the coach's buildings. Scope is derived from the coach's own org assignment,
 * never from the client.
 */
export async function GET() {
  const guard = await requireCoach();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;

  const directory = await getCoachDirectory({
    id: Number(session.user.id),
    district_id: session.user.district_id ?? null,
  });
  return NextResponse.json(directory);
}
