import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import { logUserEvent, resetPlanProgress } from "@/lib/db";

/**
 * Cancel all progress on an active partnership plan (coach or admin who manages
 * the thread). Deletes every submission and resets the current activity to the
 * start, so the whole plan becomes editable again.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ planId: string }> }
) {
  const guard = await requireUser();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  const { planId } = await params;
  const id = parseInt(planId, 10);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const me = Number(session.user.id);
  const ok = await resetPlanProgress(id, me);
  if (!ok) {
    return NextResponse.json({ error: "Couldn't reset this plan's progress." }, { status: 400 });
  }
  await logUserEvent({
    userId: me,
    actorId: me,
    action: "plan_progress_reset",
    entityType: "template",
    entityId: id,
  });
  return NextResponse.json({ ok: true });
}
