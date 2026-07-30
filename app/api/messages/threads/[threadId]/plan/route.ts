import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import { addPlanToPartnership, logThreadEvent } from "@/lib/messages";

/** Embed a plan in a thread (coach or admin). Body: { sourcePlanId }. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ threadId: string }> }
) {
  const guard = await requireUser();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  const role = session.user.system_role;
  if (role !== "coach" && role !== "admin" && role !== "district_leader") {
    return NextResponse.json({ error: "Only a coach can add a plan" }, { status: 403 });
  }
  const { threadId } = await params;
  const id = parseInt(threadId, 10);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const body = await request.json().catch(() => ({}));
  const sourcePlanId = Number(body.sourcePlanId);
  if (!Number.isFinite(sourcePlanId)) {
    return NextResponse.json({ error: "Choose a plan" }, { status: 400 });
  }

  const me = Number(session.user.id);
  const result = await addPlanToPartnership(id, me, sourcePlanId);
  if (!result.ok) {
    return NextResponse.json({ error: result.error || "Couldn't add the plan" }, { status: 403 });
  }
  await logThreadEvent({ userId: me, actorId: me, action: "plan_added", threadId: id });
  return NextResponse.json({ ok: true });
}
