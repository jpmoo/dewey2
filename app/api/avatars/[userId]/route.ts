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

  return new NextResponse(new Uint8Array(avatar.data), {
    status: 200,
    headers: {
      "Content-Type": avatar.mimeType,
      "Content-Length": String(avatar.data.length),
      // Private + must-revalidate so a changed photo isn't served stale; the
      // client also cache-busts with a ?v= query.
      "Cache-Control": "private, no-cache",
    },
  });
}
