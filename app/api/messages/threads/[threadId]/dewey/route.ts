import { NextRequest, NextResponse } from "next/server";
import { messageScope, requireUser } from "@/lib/guard";
import { canAccessThread } from "@/lib/messages";
import { askDeweyPane, getDeweyPane } from "@/lib/dewey-pane";
import { allowAiRequest } from "@/lib/rate-limit";

export const runtime = "nodejs";

/** Load the signed-in user's private Dewey side-panel conversation for a thread. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ threadId: string }> }) {
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
  return NextResponse.json(await getDeweyPane(id, me));
}

/** Ask Dewey in the private pane. Body: { message }. */
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
  if (!allowAiRequest(me)) {
    return NextResponse.json({ error: "You're sending requests too quickly — please wait a moment." }, { status: 429 });
  }
  const body = await request.json().catch(() => ({}));
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return NextResponse.json({ error: "Message required" }, { status: 400 });
  const result = await askDeweyPane({ threadId: id, userId: me, message });
  return NextResponse.json(result);
}
