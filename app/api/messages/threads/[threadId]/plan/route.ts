import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import { addPlanToPartnership, logThreadEvent } from "@/lib/messages";

/** Embed a plan in a partnership thread (coach only). Body: { sourcePlanId }. */
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
