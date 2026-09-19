import { NextRequest, NextResponse } from "next/server";
import { messageScope, requireUser } from "@/lib/guard";
import { canAccessThread, shareCopExchange, logThreadEvent } from "@/lib/messages";

/** Share a private CoP @dewey exchange with the whole community. */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ threadId: string; messageId: string }> }
) {
  const guard = await requireUser();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  const { threadId, messageId } = await params;
  const id = parseInt(threadId, 10);
  const mid = parseInt(messageId, 10);
  if (!Number.isFinite(id) || !Number.isFinite(mid)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  const me = Number(session.user.id);
  const { isAdmin, overseeDistrictId } = messageScope(session);
  if (!(await canAccessThread(id, me, isAdmin, overseeDistrictId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const ok = await shareCopExchange(id, mid, me, isAdmin);
  if (!ok) return NextResponse.json({ error: "Can't share this message" }, { status: 403 });
  await logThreadEvent({ userId: me, actorId: me, action: "cop_exchange_shared", threadId: id });
  return NextResponse.json({ ok: true });
}
