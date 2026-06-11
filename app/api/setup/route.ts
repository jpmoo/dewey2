import { NextRequest, NextResponse } from "next/server";
import { createInitialAdmin, hasAdmin } from "@/lib/db";

/**
 * First-run admin creation. Idempotent against double-submit: if an admin
 * already exists we return a clean 400 rather than creating a second one.
 * On success the dedicated admin account, the system_settings row, and the
 * jcoach/jpartner demo accounts all exist.
 */
export async function POST(request: NextRequest) {
  if (await hasAdmin()) {
    return NextResponse.json({ error: "An admin account already exists" }, { status: 400 });
  }

  const body = await request.json().catch(() => ({}));
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const full_name = typeof body.full_name === "string" ? body.full_name.trim() : "";
  const nickname = typeof body.nickname === "string" ? body.nickname.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";

  if (!username || !password || !full_name) {
    return NextResponse.json(
      { error: "Username, password, and full name are required" },
      { status: 400 }
    );
  }
  if (password.length < 8) {
    return NextResponse.json(
      { error: "Password must be at least 8 characters" },
      { status: 400 }
    );
  }

  try {
    const admin = await createInitialAdmin({
      username,
      password,
      full_name,
      nickname: nickname || null,
      email: email || null,
    });
    return NextResponse.json({ ok: true, userId: admin.id });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Setup failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
