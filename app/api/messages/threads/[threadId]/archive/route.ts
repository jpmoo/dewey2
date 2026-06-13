import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import { canAccessThread, logThreadEvent, setThreadArchived } from "@/lib/messages";
import { threadHasLivePlan } from "@/lib/db";

/** Archive or unarchive a thread for the signed-in user (their view only). */
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

  const isAdmin = session.user.system_role === "admin";
  const userId = Number(session.user.id);
  if (!(await canAccessThread(id, userId, isAdmin))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => ({}));
  const archived = body.archived !== false;

  // A partner can't archive away a conversation that still has an active plan.
  if (archived && session.user.system_role === "partner" && (await threadHasLivePlan(id))) {
    return NextResponse.json(
      { error: "This conversation has an active plan — your coach can archive it." },
      { status: 403 }
    );
  }

  // Archiving is per-user (their own view); anyone else in the thread may do it.
  await setThreadArchived(id, userId, archived);
  await logThreadEvent({
    userId,
    actorId: userId,
    action: archived ? "thread_archived" : "thread_unarchived",
    threadId: id,
  });
  return NextResponse.json({ ok: true });
}
