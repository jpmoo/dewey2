import { NextRequest, NextResponse } from "next/server";
import { messageScope, requireUser } from "@/lib/guard";
import { canAccessThread, logThreadEvent, postMessage } from "@/lib/messages";
import { getPool } from "@/lib/pg";
import { reactivateThreadPlan } from "@/lib/db";

/**
 * Revive a superseded plan: make it the active plan again and re-post it as the
 * most recent message, superseding all the others. A coach in the thread only.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ threadId: string }> }
) {
  const guard = await requireUser();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  const { threadId } = await params;
  const id = parseInt(threadId, 10);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const me = Number(session.user.id);
  const { isAdmin, overseeDistrictId } = messageScope(session);
  if (!(await canAccessThread(id, me, isAdmin, overseeDistrictId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => ({}));
  const messageId = Number(body.messageId);
  if (!Number.isFinite(messageId)) {
    return NextResponse.json({ error: "Invalid message" }, { status: 400 });
  }

  const pool = getPool();
  const res = await pool.query(
    "SELECT plan_id FROM messages WHERE id = $1 AND thread_id = $2 AND deleted_at IS NULL",
    [messageId, id]
  );
  const planId = res.rows[0]?.plan_id as number | null | undefined;
  if (planId == null) return NextResponse.json({ error: "Not a plan message" }, { status: 404 });

  const updated = await reactivateThreadPlan(planId, me);
  if (!updated) {
    return NextResponse.json({ error: "Only a coach in this conversation can revive a plan." }, { status: 403 });
  }

  // Move it to the bottom: drop the old plan message(s), post a fresh one.
  await pool.query(
    "UPDATE messages SET deleted_at = NOW() WHERE thread_id = $1 AND plan_id = $2 AND deleted_at IS NULL",
    [id, planId]
  );
  await postMessage({
    threadId: id,
    senderId: me,
    body: `Revived the plan "${updated.name}" — it's the active plan again.`,
    planId,
  });
  await logThreadEvent({ userId: me, actorId: me, action: "plan_revived", threadId: id });
  return NextResponse.json({ ok: true });
}
