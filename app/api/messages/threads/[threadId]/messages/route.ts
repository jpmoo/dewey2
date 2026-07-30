import { NextRequest, NextResponse } from "next/server";
import { messageScope, requireUser } from "@/lib/guard";
import {
  addAttachment,
  canAccessThread,
  getMessageBrief,
  getUserAttachmentBytes,
  logThreadEvent,
  postMessage,
} from "@/lib/messages";
import { mentionsDewey, runDeweyForThread } from "@/lib/dewey";
import { extractText } from "@/lib/extract";
import { sanitizeDocumentHtml } from "@/lib/html-sanitize";
import { allowAiRequest } from "@/lib/rate-limit";

// pdf-parse / mammoth need the Node runtime (not edge).
export const runtime = "nodejs";

// Per-file cap. Attachments are stored in the DB, so keep them modest.
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_FILES = 10;
// Per-user total attachment storage cap (env-overridable).
const QUOTA_BYTES =
  (Number(process.env.ATTACHMENT_QUOTA_MB) > 0 ? Number(process.env.ATTACHMENT_QUOTA_MB) : 500) *
  1024 *
  1024;

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

  const { isAdmin, overseeDistrictId } = messageScope(session);
  if (!(await canAccessThread(id, Number(session.user.id), isAdmin, overseeDistrictId))) {
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
  // Per-user storage quota across all their attachments.
  if (files.length > 0) {
    const incoming = files.reduce((sum, f) => sum + f.size, 0);
    const used = await getUserAttachmentBytes(Number(session.user.id));
    if (used + incoming > QUOTA_BYTES) {
      return NextResponse.json(
        { error: `Attachment storage limit reached (${Math.round(QUOTA_BYTES / (1024 * 1024))}MB).` },
        { status: 413 }
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
  let docCount = 0;
  let fileCount = 0;
  for (const f of files) {
    let data = Buffer.from(await f.arrayBuffer());
    const filename = f.name || "attachment";
    const mimeType = f.type || "application/octet-stream";
    // Typed documents arrive as text/html — sanitize before storing so a crafted
    // document can't inject script into the chat.
    if (mimeType === "text/html") {
      data = Buffer.from(sanitizeDocumentHtml(data.toString("utf8")), "utf8");
      docCount++;
    } else {
      fileCount++;
    }
    // Parse contents so the AI can read the attachment (null when not extractable).
    const extractedText = await extractText(filename, mimeType, data).catch(() => null);
    await addAttachment({ messageId, filename, mimeType, data, extractedText });
  }
  const me = Number(session.user.id);
  const parts: string[] = [];
  if (fileCount) parts.push(`${fileCount} file${fileCount > 1 ? "s" : ""}`);
  if (docCount) parts.push(`${docCount} document${docCount > 1 ? "s" : ""}`);
  await logThreadEvent({
    userId: me,
    actorId: me,
    action: "message_sent",
    threadId: id,
    detail: parts.length ? `attached ${parts.join(", ")}` : null,
  });

  // @dewey runs when mentioned OR when replying to one of its messages.
  // Run it before responding so the reply is there when the client refetches.
  // Rate-limited per user so the LLM can't be hammered; the message itself is
  // already saved, so over-limit just skips the AI reply.
  let aiThrottled = false;
  if (mentionsDewey(body) || replyToAi) {
    if (allowAiRequest(me)) {
      await runDeweyForThread({
        threadId: id,
        invokerId: me,
        invokerName: session.user.nickname || session.user.name || session.user.username || "A user",
        invokerIsCoach: session.user.system_role === "coach",
        invokingMessage: body,
      }).catch((e) => console.warn("[dewey] failed", e instanceof Error ? e.message : e));
    } else {
      aiThrottled = true;
    }
  }
  return NextResponse.json({ ok: true, messageId, aiThrottled });
}
