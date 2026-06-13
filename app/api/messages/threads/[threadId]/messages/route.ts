import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import {
  addAttachment,
  canAccessThread,
  getMessageBrief,
  logThreadEvent,
  postMessage,
} from "@/lib/messages";
import { mentionsDewey, runDeweyForThread } from "@/lib/dewey";

// Per-file cap. Attachments are stored in the DB, so keep them modest.
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_FILES = 10;

/**
 * Post a reply to a thread. multipart/form-data: `body` (text) plus zero or more
 * `files`. Either a non-empty body or at least one file is required.
 */
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
  if (!(await canAccessThread(id, Number(session.user.id), isAdmin))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const form = await request.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "Expected form data" }, { status: 400 });

  const body = (form.get("body") as string | null)?.trim() ?? "";
  const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);

  if (!body && files.length === 0) {
    return NextResponse.json({ error: "Message or attachment required" }, { status: 400 });
  }
  if (files.length > MAX_FILES) {
    return NextResponse.json({ error: `At most ${MAX_FILES} files per message` }, { status: 400 });
  }
  for (const f of files) {
    if (f.size > MAX_FILE_BYTES) {
      return NextResponse.json(
        { error: `"${f.name}" exceeds the ${MAX_FILE_BYTES / (1024 * 1024)}MB limit` },
        { status: 400 }
      );
    }
  }

  // Validate the reply target belongs to this thread (and learn if it's @dewey).
  const replyToRaw = Number(form.get("replyTo"));
  let replyTo: number | null = null;
  let replyToAi = false;
  if (Number.isFinite(replyToRaw)) {
    const brief = await getMessageBrief(replyToRaw);
    if (brief && brief.thread_id === id) {
      replyTo = replyToRaw;
      replyToAi = brief.is_ai;
    }
  }

  const messageId = await postMessage({
    threadId: id,
    senderId: Number(session.user.id),
    body,
    replyTo,
  });
  for (const f of files) {
    const data = Buffer.from(await f.arrayBuffer());
    await addAttachment({
      messageId,
      filename: f.name || "attachment",
      mimeType: f.type || "application/octet-stream",
      data,
    });
  }
  const me = Number(session.user.id);
  await logThreadEvent({
    userId: me,
    actorId: me,
    action: "message_sent",
    threadId: id,
    detail: files.length ? `${files.length} attachment(s)` : null,
  });

  // @dewey runs when mentioned OR when replying to one of its messages.
  // Run it before responding so the reply is there when the client refetches.
  if (mentionsDewey(body) || replyToAi) {
    await runDeweyForThread({
      threadId: id,
      invokerId: me,
      invokerName: session.user.nickname || session.user.name || session.user.username || "A user",
      invokingMessage: body,
    }).catch((e) => console.warn("[dewey] failed", e instanceof Error ? e.message : e));
  }
  return NextResponse.json({ ok: true, messageId });
}
