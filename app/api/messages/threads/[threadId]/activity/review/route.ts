import { NextRequest, NextResponse } from "next/server";
import { messageScope, requireUser } from "@/lib/guard";
import { canAccessThread } from "@/lib/messages";
import { reviewActivity } from "@/lib/activity-flow";

/** A coach approves or returns (with feedback) the pending submission. */
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
  const decision = body.decision === "return" ? "return" : body.decision === "approve" ? "approve" : null;
  if (!decision) return NextResponse.json({ error: "Invalid decision" }, { status: 400 });

  const result = await reviewActivity({
    threadId: id,
    coachId: me,
    decision,
    feedback: typeof body.feedback === "string" ? body.feedback : undefined,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status ?? 400 });
  }
  return NextResponse.json(result);
}
