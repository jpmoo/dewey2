import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";
import { createUser, getAllUsers, logUserEvent } from "@/lib/db";
import type { SystemRole } from "@/lib/db";

const ROLES: SystemRole[] = ["admin", "coach", "partner", "site_leader", "deputy_site_leader", "district_leader"];

export async function GET() {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;
  try {
    const users = await getAllUsers();
    return NextResponse.json({ users });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to list users";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;

  const body = await request.json().catch(() => ({}));
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const full_name = typeof body.full_name === "string" ? body.full_name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const system_role: SystemRole = ROLES.includes(body.system_role) ? body.system_role : "partner";

  if (!full_name) {
    return NextResponse.json({ error: "Full name is required" }, { status: 400 });
  }
  // A password is optional — but a password-less account needs an email so it can
  // sign in with Google. Username is optional (auto-generated when blank).
  if (!password && !email) {
    return NextResponse.json(
      { error: "Set a password, or an email so the user can sign in with Google." },
      { status: 400 }
    );
  }
  if (password && password.length < 8) {
    return NextResponse.json(
      { error: "Password must be at least 8 characters" },
      { status: 400 }
    );
  }

  try {
    const user = await createUser({
      username: username || undefined,
      password: password || undefined,
      full_name,
      nickname: typeof body.nickname === "string" ? body.nickname : null,
      email: typeof body.email === "string" ? body.email : null,
      system_role,
      district_id: numOrNull(body.district_id),
      school_ids: Array.isArray(body.school_ids)
        ? body.school_ids.map((v: unknown) => Number(v)).filter((n: number) => Number.isFinite(n))
        : undefined,
      school_id: numOrNull(body.school_id),
      role: typeof body.role === "string" ? body.role : null,
      about: typeof body.about === "string" ? body.about : null,
    });
    await logUserEvent({
      userId: user.id,
      actorId: Number(session.user.id),
      action: "created",
      detail: `role: ${user.system_role}`,
    });
    return NextResponse.json({ user });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to create user";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

function numOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}
