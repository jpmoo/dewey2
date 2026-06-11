import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { setUserTheme } from "@/lib/db";

/** Save the current user's theme preference. Any authenticated user may set their own. */
export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await request.json().catch(() => ({}));
  const theme = body.theme === "dark" ? "dark" : body.theme === "light" ? "light" : null;
  if (!theme) {
    return NextResponse.json({ error: "theme must be 'light' or 'dark'" }, { status: 400 });
  }
  await setUserTheme(Number(session.user.id), theme);
  return NextResponse.json({ ok: true });
}
