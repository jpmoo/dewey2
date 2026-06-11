import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import type { Session } from "next-auth";
import { authOptions, isAdminSession } from "@/lib/auth";

/**
 * Guard for admin-only API routes. Returns the session on success, or a ready
 * NextResponse (401/403) to return directly. Usage:
 *
 *   const guard = await requireAdmin();
 *   if (guard instanceof NextResponse) return guard;
 *   const { session } = guard;
 */
export async function requireAdmin(): Promise<{ session: Session } | NextResponse> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isAdminSession(session)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return { session };
}
