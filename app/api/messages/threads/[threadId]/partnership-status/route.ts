import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import { getThreadMeta, logThreadEvent, setThreadStatus } from "@/lib/messages";

const ALLOWED = ["active", "done", "abandoned"] as const;

/** Mark a partnership done / abandoned (or reopen). Coach (creator) only. */
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
  const status = body.status;
  if (!ALLOWED.includes(status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  const me = Number(session.user.id);
  const thread = await getThreadMeta(id);
  if (!thread || thread.kind !== "partnership") {
    return NextResponse.json({ error: "Not a partnership" }, { status: 404 });
  }
  if (thread.created_by !== me) {
    return NextResponse.json({ error: "Only the coach can change this." }, { status: 403 });
  }

  await setThreadStatus(id, status === "active" ? null : status);
  await logThreadEvent({
    userId: me,
    actorId: me,
    action: status === "active" ? "partnership_reopened" : `partnership_${status}`,
    threadId: id,
  });
  return NextResponse.json({ ok: true });
}
