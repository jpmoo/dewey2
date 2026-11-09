import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";
import { logUserEvent, PURGED_NAME, purgeUser } from "@/lib/db";

/**
 * Delete an archived user forever. Admin only. Body: { userId }. The account
 * must already be archived (soft-deleted); its identity is scrubbed to
 * "[deleted]" and it can't be restored afterwards. See purgeUser.
 */
export async function POST(request: NextRequest) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;

  const body = await request.json().catch(() => ({}));
  const userId = Number(body.userId);
  if (!Number.isFinite(userId)) return NextResponse.json({ error: "Invalid user" }, { status: 400 });
  const adminId = Number(session.user.id);
  if (userId === adminId) {
    return NextResponse.json({ error: "You can't delete your own account." }, { status: 400 });
  }

  if (!(await purgeUser(userId))) {
    return NextResponse.json(
      { error: "Only an archived account can be deleted forever." },
      { status: 404 }
    );
  }

  await logUserEvent({
    userId: adminId,
    actorId: adminId,
    action: "user_purged",
    entityType: "user",
    entityId: userId,
    entityLabel: PURGED_NAME,
  });
  return NextResponse.json({ ok: true });
}
