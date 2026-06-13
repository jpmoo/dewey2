import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import { canAccessThread, deleteMessage, logThreadEvent } from "@/lib/messages";
import { getPool } from "@/lib/pg";
import { deleteTemplate, getTemplate } from "@/lib/db";

/** Dismiss an embedded plan (remove the plan message). The plan's owner only. */
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
  const isAdmin = session.user.system_role === "admin";
  if (!(await canAccessThread(id, me, isAdmin))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => ({}));
  const messageId = Number(body.messageId);
  if (!Number.isFinite(messageId)) {
    return NextResponse.json({ error: "Invalid message" }, { status: 400 });
  }

  // Confirm the message is a plan message in this thread, then remove both.
  const pool = getPool();
  const res = await pool.query(
    "SELECT plan_id FROM messages WHERE id = $1 AND thread_id = $2 AND deleted_at IS NULL",
    [messageId, id]
  );
  const planId = res.rows[0]?.plan_id as number | null | undefined;
  if (planId == null) return NextResponse.json({ error: "Not a plan message" }, { status: 404 });

  // Only the plan's owner (the coach who added it) can dismiss it.
  const plan = await getTemplate(planId);
  if (!plan || plan.owner_id !== me) {
    return NextResponse.json({ error: "Only the coach who added this plan can dismiss it." }, { status: 403 });
  }
  // An accepted plan is locked in — it can't be dismissed/replaced.
  if (plan.accepted_at) {
    return NextResponse.json({ error: "An accepted plan is locked and can't be dismissed." }, { status: 403 });
  }

  await deleteMessage(messageId);
  await deleteTemplate(planId); // soft-delete the embedded copy
  await logThreadEvent({ userId: me, actorId: me, action: "plan_dismissed", threadId: id });
  return NextResponse.json({ ok: true });
}
