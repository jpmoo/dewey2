import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import { respondToInvitation } from "@/lib/messages";

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
  const ok = await respondToInvitation(id, Number(session.user.id), body.accept === true);
  if (!ok) return NextResponse.json({ error: "No pending invitation" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
