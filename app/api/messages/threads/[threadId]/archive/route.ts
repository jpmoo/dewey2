import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import {
  canAccessThread,
  logThreadEvent,
  setThreadArchivedForAll,
} from "@/lib/messages";
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

  // No one but an admin can archive a conversation that still has an active plan
  // — finish or abandon the plan first.
  if (archived && session.user.system_role !== "admin" && (await threadHasLivePlan(id))) {
    return NextResponse.json(
      { error: "This conversation has an active plan — finish or abandon it before archiving." },
      { status: 403 }
    );
  }

  // Archiving closes the conversation for everyone (all participants), plus the
  // actor — so a non-participant admin's oversight view is closed too. Unarchiving
  // reopens it for all.
  await setThreadArchivedForAll(id, archived, userId);
  await logThreadEvent({
    userId,
    actorId: userId,
    action: archived ? "thread_archived" : "thread_unarchived",
    threadId: id,
  });
  return NextResponse.json({ ok: true });
}
