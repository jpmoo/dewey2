import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import { deleteUserAvatar, logUserEvent, setUserAvatar } from "@/lib/db";

const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

/** Upload the user's own profile photo (a cropped square image). */
export async function POST(request: NextRequest) {
  const guard = await requireUser();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "No image provided" }, { status: 400 });
  }
  if (!file.type.startsWith("image/")) {
    return NextResponse.json({ error: "File must be an image" }, { status: 400 });
  }
  if (file.size > MAX_AVATAR_BYTES) {
    return NextResponse.json({ error: "Image is too large (max 5MB)" }, { status: 400 });
  }

  const id = Number(session.user.id);
  const data = Buffer.from(await file.arrayBuffer());
  await setUserAvatar(id, file.type, data);
  await logUserEvent({ userId: id, actorId: id, action: "updated", detail: "profile photo (self)" });
  return NextResponse.json({ ok: true });
}

/** Remove the user's profile photo. */
export async function DELETE() {
  const guard = await requireUser();
  if (guard instanceof NextResponse) return guard;
  const id = Number(guard.session.user.id);
  await deleteUserAvatar(id);
  return NextResponse.json({ ok: true });
}
