import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import { logThreadEvent, respondToInvitation } from "@/lib/messages";

/** Accept or decline a partnership invitation. */
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
  const accept = body.accept === true;
  const me = Number(session.user.id);
  const ok = await respondToInvitation(id, me, accept);
  if (!ok) return NextResponse.json({ error: "No pending invitation" }, { status: 404 });
  await logThreadEvent({
    userId: me,
    actorId: me,
    action: accept ? "invitation_accepted" : "invitation_declined",
    threadId: id,
  });
  return NextResponse.json({ ok: true });
}
