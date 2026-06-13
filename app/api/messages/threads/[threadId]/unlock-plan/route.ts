import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import { getThreadMeta, logThreadEvent } from "@/lib/messages";
import { getPool } from "@/lib/pg";
import { unlockPartnershipPlan } from "@/lib/db";

/**
 * Unlock an accepted partnership plan so it can be edited/replaced again. This
 * restarts the plan (clears acceptance + progress). Coach (creator) only.
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

  const meta = await getThreadMeta(id);
  const me = Number(session.user.id);
  if (!meta || meta.created_by !== me) {
    return NextResponse.json({ error: "Only the coach can unlock a plan" }, { status: 403 });
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

  const unlocked = await unlockPartnershipPlan(planId, me);
  if (!unlocked) return NextResponse.json({ error: "Couldn't unlock that plan" }, { status: 400 });

  await logThreadEvent({ userId: me, actorId: me, action: "plan_unlocked", threadId: id });
  return NextResponse.json({ ok: true });
}
