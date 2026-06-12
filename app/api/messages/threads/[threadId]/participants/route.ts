import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import { addUserToThread } from "@/lib/messages";

/** Add a user to a thread by id (after an @-mention selection). */
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
  const targetId = Number(body.userId);
  if (!Number.isFinite(targetId)) {
    return NextResponse.json({ error: "Invalid user" }, { status: 400 });
  }
  const result = await addUserToThread(id, Number(session.user.id), targetId);
  if (!result.ok) {
    return NextResponse.json({ error: result.error || "Can't add that user" }, { status: 403 });
  }
  return NextResponse.json({ ok: true, pending: result.pending });
}
