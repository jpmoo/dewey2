import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import { getUserById, logUserEvent, updateUser } from "@/lib/db";

/** The signed-in user's own profile (read-only fields included for context). */
export async function GET() {
  const guard = await requireUser();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  const user = await getUserById(Number(session.user.id));
  if (!user) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({
    profile: {
      username: user.username,
      full_name: user.full_name,
      nickname: user.nickname,
      email: user.email,
      role: user.role,
      about: user.about,
    },
  });
}

/**
 * Update the user's own editable profile fields: display name, nickname, title,
 * and description. Username and org assignment are intentionally not editable
 * here — those are admin-managed.
 */
export async function PATCH(request: NextRequest) {
  const guard = await requireUser();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  const id = Number(session.user.id);

  const user = await getUserById(id);
  if (!user) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await request.json().catch(() => ({}));
  const update: {
    full_name?: string;
    nickname?: string | null;
    role?: string | null;
    about?: string | null;
  } = {};
  if (typeof body.full_name === "string") {
    if (!body.full_name.trim()) {
      return NextResponse.json({ error: "Name can't be empty" }, { status: 400 });
    }
    update.full_name = body.full_name;
  }
  if ("nickname" in body) update.nickname = body.nickname == null ? null : String(body.nickname);
  if ("role" in body) update.role = body.role == null ? null : String(body.role);
  if ("about" in body) update.about = body.about == null ? null : String(body.about);

  const updated = await updateUser(id, update);

  // Note what changed in the user's own audit log.
  const changes: string[] = [];
  if (update.full_name !== undefined && update.full_name.trim() !== user.full_name)
    changes.push("name");
  if (update.nickname !== undefined && (update.nickname || "") !== (user.nickname || ""))
    changes.push("nickname");
  if (update.role !== undefined && (update.role || "") !== (user.role || ""))
    changes.push("title");
  if (update.about !== undefined && (update.about || "") !== (user.about || ""))
    changes.push("description");
  if (changes.length > 0) {
    await logUserEvent({
      userId: id,
      actorId: id,
      action: "updated",
      detail: `${changes.join(", ")} (self)`,
    });
  }

  return NextResponse.json({
    profile: {
      username: updated.username,
      full_name: updated.full_name,
      nickname: updated.nickname,
      email: updated.email,
      role: updated.role,
      about: updated.about,
    },
  });
}
