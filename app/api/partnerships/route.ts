import { NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import { getPartnershipsForUser } from "@/lib/messages";

/** Partnerships the signed-in user can see (created as a coach, or accepted). */
export async function GET() {
  const guard = await requireUser();
  if (guard instanceof NextResponse) return guard;
  const partnerships = await getPartnershipsForUser(Number(guard.session.user.id));
  return NextResponse.json({ partnerships });
}
