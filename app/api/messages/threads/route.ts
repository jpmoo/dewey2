import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import { getMessageRecipients, type SystemRole } from "@/lib/db";
import { findOrCreateDirectThread, listThreadsForUser, postMessage } from "@/lib/messages";

/** Threads the user participates in. Admins see every thread (oversight). */
export async function GET() {
  const guard = await requireUser();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  const isAdmin = session.user.system_role === "admin";
  const threads = await listThreadsForUser(Number(session.user.id), isAdmin);
  return NextResponse.json({ threads, isAdmin });
}

/**
 * Start (or reuse) a direct thread with an allowed recipient and post the first
 * message. Eligibility is recomputed server-side from the sender's role.
 */
export async function POST(request: NextRequest) {
  const guard = await requireUser();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  const meId = Number(session.user.id);

  const body = await request.json().catch(() => ({}));
  const recipientId = Number(body.recipientId);
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!Number.isFinite(recipientId)) {
    return NextResponse.json({ error: "Choose someone to message" }, { status: 400 });
  }
  if (!message) {
    return NextResponse.json({ error: "Write a message" }, { status: 400 });
  }

  const allowed = await getMessageRecipients({
    id: meId,
    system_role: session.user.system_role as SystemRole,
  });
  if (!allowed.some((r) => r.id === recipientId)) {
    return NextResponse.json({ error: "You can't message that user" }, { status: 403 });
  }

  const threadId = await findOrCreateDirectThread(meId, recipientId);
  await postMessage({ threadId, senderId: meId, body: message });
  return NextResponse.json({ ok: true, threadId });
}
