import { NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import { getCoachPendingApprovals } from "@/lib/messages";

/** Coach dashboard: submissions awaiting the coach's review across their threads. */
export async function GET() {
  const guard = await requireUser();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  if (session.user.system_role !== "coach" && session.user.system_role !== "admin") {
    return NextResponse.json({ pending: [] });
  }
  const pending = await getCoachPendingApprovals(Number(session.user.id));
  return NextResponse.json({ pending });
}
