import { NextRequest, NextResponse } from "next/server";
import { messageScope, requireUser } from "@/lib/guard";
import {
  canAccessThread,
  getCopMeta,
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

  const { isAdmin, overseeDistrictId, canOversee } = messageScope(session);
  const userId = Number(session.user.id);
  if (!(await canAccessThread(id, userId, isAdmin, overseeDistrictId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // A Community of Practice is archived only by its Chair, an admin, or an
  // overseeing district leader — not by an ordinary member.
  const cop = await getCopMeta(id);
  if (cop) {
    const mayManage = isAdmin || canOversee || cop.chairId === userId;
    if (!mayManage) {
      return NextResponse.json(
        { error: "Only the Chair can archive this community." },
        { status: 403 }
      );
    }
  }

  const body = await request.json().catch(() => ({}));
  const archived = body.archived !== false;

  // Oversight roles (admin / district leader) can archive despite an active plan;
  // others must finish or abandon the plan first.
  if (archived && !canOversee && (await threadHasLivePlan(id))) {
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
