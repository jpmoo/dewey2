import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import { createTemplate, threadHasAcceptedPlan } from "@/lib/db";
import { getPool } from "@/lib/pg";
import { getCopMeta, logThreadEvent } from "@/lib/messages";

/**
 * Create a blank arc for a Community of Practice for the Chair to draw on the
 * canvas. Returns the new plan id; the canvas then edits it in place (which
 * activates it). Allowed for the Chair, a coach/admin/district leader.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ threadId: string }> }
) {
  const guard = await requireUser();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  const me = Number(session.user.id);
  const id = parseInt((await params).threadId, 10);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const cop = await getCopMeta(id);
  if (!cop) return NextResponse.json({ error: "Not a community of practice" }, { status: 404 });
  const role = session.user.system_role;
  const allowed =
    role === "admin" || role === "coach" || role === "district_leader" || cop.chairId === me;
  if (!allowed) {
    return NextResponse.json({ error: "Only the Chair can build the arc." }, { status: 403 });
  }
  if (await threadHasAcceptedPlan(id)) {
    return NextResponse.json({ error: "This community already has an active arc." }, { status: 409 });
  }

  // Reuse an existing unsaved draft rather than piling up empty plans if the
  // Chair reopens "Build a plan" without saving.
  const draft = await getPool().query(
    `SELECT id FROM coaching_templates
      WHERE thread_id = $1 AND scope = 'partnership' AND deleted_at IS NULL
        AND accepted_at IS NULL AND deactivated_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [id]
  );
  if (draft.rows[0]) {
    return NextResponse.json({ ok: true, planId: draft.rows[0].id as number });
  }

  const template = await createTemplate({
    name: "Community arc",
    description: "Drawn for this community of practice.",
    createdBy: me,
    scope: "partnership",
    ownerId: me,
    threadId: id,
  });
  await logThreadEvent({ userId: me, actorId: me, action: "cop_plan_started", threadId: id });
  return NextResponse.json({ ok: true, planId: template.id });
}
