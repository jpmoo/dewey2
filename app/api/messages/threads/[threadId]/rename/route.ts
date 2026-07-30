import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import { getThreadMeta, logThreadEvent, setThreadSubject } from "@/lib/messages";

const MAX_LEN = 120;

/** Rename a partnership thread. Coach (creator) or admin only. */
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
  const subject = typeof body.subject === "string" ? body.subject.trim() : "";
  if (!subject) return NextResponse.json({ error: "Name can't be empty" }, { status: 400 });
  if (subject.length > MAX_LEN) {
    return NextResponse.json({ error: `Keep it under ${MAX_LEN} characters` }, { status: 400 });
  }

  const me = Number(session.user.id);
  const role = session.user.system_role;
  const canRename = role === "admin" || role === "coach" || role === "district_leader";
  const thread = await getThreadMeta(id);
  if (!thread || thread.kind === "compliance") {
    return NextResponse.json({ error: "Can't rename this conversation" }, { status: 404 });
  }
  if (!canRename) {
    return NextResponse.json({ error: "Only a coach or an admin can rename this." }, { status: 403 });
  }

  await setThreadSubject(id, subject);
  await logThreadEvent({
    userId: me,
    actorId: me,
    action: "thread_renamed",
    threadId: id,
    detail: subject,
  });
  return NextResponse.json({ ok: true });
}
