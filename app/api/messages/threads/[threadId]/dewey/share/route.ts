import { NextRequest, NextResponse } from "next/server";
import { messageScope, requireUser } from "@/lib/guard";
import { canAccessThread, logThreadEvent } from "@/lib/messages";
import { shareDeweyPane, type ShareMode } from "@/lib/dewey-pane";

export const runtime = "nodejs";

/** Share the user's private Dewey conversation into the thread. Body: { mode }. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ threadId: string }> }) {
  const guard = await requireUser();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  const id = parseInt((await params).threadId, 10);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  const me = Number(session.user.id);
  const { isAdmin, overseeDistrictId } = messageScope(session);
  if (!(await canAccessThread(id, me, isAdmin, overseeDistrictId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const body = await request.json().catch(() => ({}));
  const mode: ShareMode = body.mode === "live" ? "live" : "snapshot";
  try {
    const r = await shareDeweyPane({ threadId: id, userId: me, mode });
    await logThreadEvent({ userId: me, actorId: me, action: "dewey_shared", threadId: id, detail: mode });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Couldn't share" }, { status: 400 });
  }
}
