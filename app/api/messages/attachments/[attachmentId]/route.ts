import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import { canAccessThread, getAttachmentForDownload } from "@/lib/messages";

// Only these exact types are rendered inline. Notably SVG and HTML are NOT here
// — they can carry script — so they're force-downloaded and relabeled as
// octet-stream. Every response also gets nosniff + a sandbox CSP so a
// MIME-spoofed upload can't execute in the user's session (stored XSS).
const SAFE_INLINE = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
]);

/** Stream an attachment to a participant (or admin). Inline only for safe types. */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ attachmentId: string }> }
) {
  const guard = await requireUser();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  const { attachmentId } = await params;
  const id = parseInt(attachmentId, 10);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const att = await getAttachmentForDownload(id);
  if (!att) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const isAdmin = session.user.system_role === "admin";
  if (!(await canAccessThread(att.threadId, Number(session.user.id), isAdmin))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const inline = SAFE_INLINE.has(att.mimeType);
  // Non-inline types are force-downloaded and de-typed so the browser can't be
  // tricked into executing a spoofed text/html or SVG payload.
  const contentType = inline ? att.mimeType : "application/octet-stream";
  const disposition = inline ? "inline" : "attachment";
  // Encode the filename for the header.
  const safeName = encodeURIComponent(att.filename);

  return new NextResponse(new Uint8Array(att.data), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(att.data.length),
      "Content-Disposition": `${disposition}; filename*=UTF-8''${safeName}`,
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
    },
  });
}
