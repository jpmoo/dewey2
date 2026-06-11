import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";
import {
  deleteUser,
  getAdminCount,
  getUserById,
  updateUser,
} from "@/lib/db";
import type { SystemRole, UpdateUserParams } from "@/lib/db";

const ROLES: SystemRole[] = ["admin", "coach", "partner"];

function parseId(userId: string): number | null {
  const id = parseInt(userId, 10);
  return Number.isFinite(id) ? id : null;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;
  const { userId } = await params;
  const id = parseId(userId);
  if (id === null) return NextResponse.json({ error: "Invalid user id" }, { status: 400 });
  const user = await getUserById(id);
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
  return NextResponse.json({ user });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  const { userId } = await params;
  const id = parseId(userId);
  if (id === null) return NextResponse.json({ error: "Invalid user id" }, { status: 400 });

  const user = await getUserById(id);
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const body = await request.json().catch(() => ({}));
  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const update: UpdateUserParams = {};
  if (typeof body.full_name === "string") update.full_name = body.full_name;
  if ("nickname" in body) update.nickname = body.nickname == null ? null : String(body.nickname);
  if ("email" in body) update.email = body.email == null ? null : String(body.email);
  if (ROLES.includes(body.system_role)) update.system_role = body.system_role;
  if ("district_id" in body) update.district_id = numOrNull(body.district_id);
  if ("school_id" in body) update.school_id = numOrNull(body.school_id);
  if ("role" in body) update.role = body.role == null ? null : String(body.role);
  if ("about" in body) update.about = body.about == null ? null : String(body.about);
  // null = clear override (inherit system defaults); array = per-user override.
  if ("rag_collections_override" in body) {
    const v = body.rag_collections_override;
    if (v === null) update.ragCollectionsOverride = null;
    else if (Array.isArray(v))
      update.ragCollectionsOverride = v.filter((c: unknown): c is string => typeof c === "string");
  }
  if (typeof body.password === "string" && body.password !== "") {
    if (body.password.length < 8) {
      return NextResponse.json(
        { error: "Password must be at least 8 characters" },
        { status: 400 }
      );
    }
    update.password = body.password;
  }

  // Guard against the last admin demoting themselves and locking everyone out.
  const sessionUid = parseInt(session.user.id, 10);
  const demotingSelf =
    sessionUid === id && update.system_role !== undefined && update.system_role !== "admin";
  const demotingAnyAdmin =
    user.system_role === "admin" && update.system_role !== undefined && update.system_role !== "admin";
  if (demotingSelf || demotingAnyAdmin) {
    if ((await getAdminCount()) <= 1) {
      return NextResponse.json(
        { error: "Cannot remove the last administrator." },
        { status: 400 }
      );
    }
  }

  try {
    const updated = await updateUser(id, update);
    return NextResponse.json({ user: updated });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to update user";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  const { userId } = await params;
  const id = parseId(userId);
  if (id === null) return NextResponse.json({ error: "Invalid user id" }, { status: 400 });

  if (parseInt(session.user.id, 10) === id) {
    return NextResponse.json({ error: "You can't delete your own account." }, { status: 400 });
  }

  const user = await getUserById(id);
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
  if (user.system_role === "admin" && (await getAdminCount()) <= 1) {
    return NextResponse.json({ error: "Cannot delete the last administrator." }, { status: 400 });
  }

  try {
    const ok = await deleteUser(id);
    if (!ok) return NextResponse.json({ error: "Failed to delete user" }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to delete user";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function numOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}
