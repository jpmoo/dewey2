import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import { canAccessThread, getThreadMeta, setThreadArchived } from "@/lib/messages";

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

  // A partnership can only be archived by its coach, and only once it's been
  // marked done or abandoned. Anyone may unarchive their own view.
  const thread = await getThreadMeta(id);
  if (thread?.kind === "partnership" && archived) {
    if (thread.created_by !== userId) {
      return NextResponse.json(
        { error: "Only the coach can archive a partnership." },
        { status: 403 }
      );
    }
    if (thread.status !== "done" && thread.status !== "abandoned") {
      return NextResponse.json(
        { error: "Mark the partnership done or abandoned before archiving it." },
        { status: 400 }
      );
    }
  }

  await setThreadArchived(id, userId, archived);
  return NextResponse.json({ ok: true });
}
