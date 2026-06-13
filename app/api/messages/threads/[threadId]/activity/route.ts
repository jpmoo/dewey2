import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import { canAccessThread, getActiveActivity } from "@/lib/messages";
import { userManagesThreadPlan } from "@/lib/db";
import { getReviewData } from "@/lib/activity-flow";

/**
 * Full payload for the coach's review modal (submission, phase history, and the
 * private @dewey consult). Coach-only: this includes the coach's confidential
 * assessment, so partners must never read it even though they can access the
 * thread. (The review UI is coach-only anyway.)
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ threadId: string }> }
) {
  const guard = await requireUser();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  const { threadId } = await params;
  const id = parseInt(threadId, 10);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const me = Number(session.user.id);
  const isAdmin = session.user.system_role === "admin";
  if (!(await canAccessThread(id, me, isAdmin))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Only a coach who manages this thread's plan (or an admin) may read it.
  const active = await getActiveActivity(id);
  const allowed = isAdmin || (active != null && (await userManagesThreadPlan(active.planId, me)));
  if (!allowed) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const data = await getReviewData(id);
  return NextResponse.json({ data });
}
