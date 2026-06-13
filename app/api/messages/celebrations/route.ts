import { NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import { getRecentCelebrations } from "@/lib/messages";

/** Recent completion notes in the user's threads (for the login fireworks check). */
export async function GET() {
  const guard = await requireUser();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  const isAdmin = session.user.system_role === "admin";
  const celebrations = await getRecentCelebrations(Number(session.user.id), isAdmin);
  return NextResponse.json({ celebrations });
}
