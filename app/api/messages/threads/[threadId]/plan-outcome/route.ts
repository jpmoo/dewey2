import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import { canAccessThread, logThreadEvent } from "@/lib/messages";
import { getPool } from "@/lib/pg";
import { setPlanOutcome } from "@/lib/db";

const ALLOWED = ["finished", "abandoned", "active"] as const;

/**
 * Mark the active plan finished / abandoned (or reopen to in-progress). The
 * plan's owner only — enforced by setPlanOutcome. This is about the PLAN, not the
 * thread (archiving is separate).
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
  const isAdmin = session.user.system_role === "admin";
  if (!(await canAccessThread(id, me, isAdmin))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => ({}));
  const messageId = Number(body.messageId);
  const outcome = body.outcome;
  if (!Number.isFinite(messageId) || !ALLOWED.includes(outcome)) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const pool = getPool();
  const res = await pool.query(
    "SELECT plan_id FROM messages WHERE id = $1 AND thread_id = $2 AND deleted_at IS NULL",
    [messageId, id]
  );
  const planId = res.rows[0]?.plan_id as number | null | undefined;
  if (planId == null) return NextResponse.json({ error: "Not a plan message" }, { status: 404 });

  const updated = await setPlanOutcome(planId, me, outcome === "active" ? null : outcome);
  if (!updated) return NextResponse.json({ error: "Couldn't update the plan" }, { status: 400 });

  await logThreadEvent({
    userId: me,
    actorId: me,
    action:
      outcome === "finished" ? "plan_finished" : outcome === "abandoned" ? "plan_abandoned" : "plan_reopened",
    threadId: id,
  });
  return NextResponse.json({ ok: true });
}
