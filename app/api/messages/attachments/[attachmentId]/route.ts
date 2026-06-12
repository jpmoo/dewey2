import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import { canAccessThread, getAttachmentForDownload } from "@/lib/messages";

// Inline-previewable types are served with `inline`; everything else downloads.
const INLINE_PREFIXES = ["image/"];
const INLINE_EXACT = ["application/pdf"];

/** Stream an attachment to a participant (or admin). Inline for images/PDF. */
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

  const inline =
    INLINE_PREFIXES.some((p) => att.mimeType.startsWith(p)) || INLINE_EXACT.includes(att.mimeType);
  const disposition = inline ? "inline" : "attachment";
  // Encode the filename for the header.
  const safeName = encodeURIComponent(att.filename);

  return new NextResponse(new Uint8Array(att.data), {
    status: 200,
    headers: {
      "Content-Type": att.mimeType,
      "Content-Length": String(att.data.length),
      "Content-Disposition": `${disposition}; filename*=UTF-8''${safeName}`,
      "Cache-Control": "private, max-age=3600",
    },
  });
}
