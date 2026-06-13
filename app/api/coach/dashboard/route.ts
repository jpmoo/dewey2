import { NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import { getCoachPendingApprovals, getUnreadThreadsForUser } from "@/lib/messages";

/** Coach dashboard: submissions awaiting review + threads with unread messages. */
export async function GET() {
  const guard = await requireUser();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  const isAdmin = session.user.system_role === "admin";
  if (session.user.system_role !== "coach" && !isAdmin) {
    return NextResponse.json({ pending: [], unread: [] });
  }
  const me = Number(session.user.id);
  const [pending, unread] = await Promise.all([
    getCoachPendingApprovals(me),
    getUnreadThreadsForUser(me, isAdmin),
  ]);
  return NextResponse.json({ pending, unread });
}
