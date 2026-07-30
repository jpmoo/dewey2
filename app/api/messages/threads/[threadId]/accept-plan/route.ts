import { NextRequest, NextResponse } from "next/server";
import { messageScope, requireUser } from "@/lib/guard";
import { canAccessThread, logThreadEvent } from "@/lib/messages";
import { getPool } from "@/lib/pg";
import { recordPlanAcceptance } from "@/lib/db";

/**
 * Accept an embedded plan. Any thread participant accepts; once everyone has
 * accepted, the plan locks in as the active plan.
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

  // Confirm the message is a plan message in this thread.
  const pool = getPool();
  const res = await pool.query(
    "SELECT plan_id FROM messages WHERE id = $1 AND thread_id = $2 AND deleted_at IS NULL",
    [messageId, id]
  );
  const planId = res.rows[0]?.plan_id as number | null | undefined;
  if (planId == null) return NextResponse.json({ error: "Not a plan message" }, { status: 404 });

  const result = await recordPlanAcceptance(planId, me);
  if (!result) return NextResponse.json({ error: "Couldn't accept that plan" }, { status: 400 });

  await logThreadEvent({ userId: me, actorId: me, action: "plan_accepted", threadId: id });
  return NextResponse.json({ ok: true, locked: result.locked });
}
