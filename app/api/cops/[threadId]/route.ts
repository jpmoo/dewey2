import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import { getPool } from "@/lib/pg";
import { getUserById } from "@/lib/db";
import { updateCoP, logThreadEvent } from "@/lib/messages";

/**
 * Edit a Community of Practice (goal, Chair, name). Allowed: a system admin, the
 * current Chair, the coach who created it, or a district leader of the CoP's
 * anchor district. A new Chair must already be a member.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ threadId: string }> }
) {
  const guard = await requireUser();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  const me = Number(session.user.id);
  const id = parseInt((await params).threadId, 10);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const pool = getPool();
  const tRes = await pool.query(
    "SELECT created_by, cop_chair_id, cop_district_id FROM message_threads WHERE id = $1 AND kind = 'cop' AND deleted_at IS NULL",
    [id]
  );
  const t = tRes.rows[0];
  if (!t) return NextResponse.json({ error: "Community not found" }, { status: 404 });

  const role = session.user.system_role;
  let allowed =
    role === "admin" || me === Number(t.cop_chair_id) || me === Number(t.created_by);
  if (!allowed && role === "district_leader") {
    const meUser = await getUserById(me);
    allowed = meUser?.district_id != null && meUser.district_id === Number(t.cop_district_id);
  }
  if (!allowed) {
    return NextResponse.json({ error: "You can't edit this community." }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const fields: { subject?: string; goal?: string; chairId?: number } = {};
  if (typeof body.subject === "string") {
    if (!body.subject.trim()) return NextResponse.json({ error: "Name can't be empty." }, { status: 400 });
    fields.subject = body.subject;
  }
  if (typeof body.goal === "string") {
    if (!body.goal.trim()) return NextResponse.json({ error: "Goal can't be empty." }, { status: 400 });
    fields.goal = body.goal;
  }
  if (body.chairId !== undefined) {
    const chairId = Number(body.chairId);
    if (!Number.isFinite(chairId)) return NextResponse.json({ error: "Invalid Chair." }, { status: 400 });
    const member = await pool.query(
      "SELECT 1 FROM thread_participants WHERE thread_id = $1 AND user_id = $2",
      [id, chairId]
    );
    if (!member.rows[0]) {
      return NextResponse.json({ error: "The Chair must be a member of the community." }, { status: 400 });
    }
    fields.chairId = chairId;
  }
  if (Object.keys(fields).length === 0) return NextResponse.json({ ok: true });

  try {
    await updateCoP(id, fields);
    await logThreadEvent({ userId: me, actorId: me, action: "cop_updated", threadId: id, detail: Object.keys(fields).join(", ") });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to update" }, { status: 500 });
  }
}
