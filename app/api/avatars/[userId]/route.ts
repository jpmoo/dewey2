import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import { getUserAvatar } from "@/lib/db";

/** Stream a user's profile photo. Any signed-in user may view avatars. */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  const guard = await requireUser();
  if (guard instanceof NextResponse) return guard;
  const { userId } = await params;
  const id = parseInt(userId, 10);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const avatar = await getUserAvatar(id);
  if (!avatar) return NextResponse.json({ error: "No avatar" }, { status: 404 });

  // Avatars should always be raster images; serve a known-safe content-type and
  // de-type anything else (e.g. an SVG that could carry script). nosniff + a
  // sandbox CSP keep a spoofed upload from executing same-origin.
  const SAFE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
  const contentType = SAFE.has(avatar.mimeType) ? avatar.mimeType : "application/octet-stream";

  return new NextResponse(new Uint8Array(avatar.data), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(avatar.data.length),
      // Private + must-revalidate so a changed photo isn't served stale; the
      // client also cache-busts with a ?v= query.
      "Cache-Control": "private, no-cache",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
    },
  });
}
