import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import {
  canAccessThread,
  getActiveActivity,
  getThreadLastRead,
  getThreadMessages,
  getThreadMeta,
  markThreadRead,
} from "@/lib/messages";

/** A thread's metadata and messages (with attachment metadata). */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ threadId: string }> }
) {
  const guard = await requireUser();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  const { threadId } = await params;
  const id = parseInt(threadId, 10);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const isAdmin = session.user.system_role === "admin";
  if (!(await canAccessThread(id, Number(session.user.id), isAdmin))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const thread = await getThreadMeta(id);
  if (!thread) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const messages = await getThreadMessages(id, { userId: Number(session.user.id), isAdmin });
  const activeActivity = await getActiveActivity(id);
  // Capture the prior last-read time (so the client can scroll to the first
  // unread message) BEFORE marking the thread read.
  const lastReadAt = await getThreadLastRead(id, Number(session.user.id));
  await markThreadRead(id, Number(session.user.id));
  return NextResponse.json({ thread, messages, activeActivity, lastReadAt });
}
