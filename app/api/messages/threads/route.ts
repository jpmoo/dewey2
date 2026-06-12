import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import { getMessageRecipients, type SystemRole } from "@/lib/db";
import { findOrCreateThread, listThreadsForUser, postMessage } from "@/lib/messages";

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
  // Accept recipientIds[] (group) or a single recipientId (back-compat).
  const rawIds: unknown[] = Array.isArray(body.recipientIds)
    ? body.recipientIds
    : body.recipientId != null
    ? [body.recipientId]
    : [];
  const recipientIds = Array.from(
    new Set(rawIds.map((v) => Number(v)).filter((n) => Number.isFinite(n) && n !== meId))
  );
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (recipientIds.length === 0) {
    return NextResponse.json({ error: "Choose at least one recipient" }, { status: 400 });
  }
  if (!message) {
    return NextResponse.json({ error: "Write a message" }, { status: 400 });
  }

  const allowedIds = new Set(
    (
      await getMessageRecipients({
        id: meId,
        system_role: session.user.system_role as SystemRole,
      })
    ).map((r) => r.id)
  );
  if (!recipientIds.every((id) => allowedIds.has(id))) {
    return NextResponse.json({ error: "You can't message one of those users" }, { status: 403 });
  }

  const threadId = await findOrCreateThread(meId, recipientIds);
  await postMessage({ threadId, senderId: meId, body: message });
  return NextResponse.json({ ok: true, threadId });
}
