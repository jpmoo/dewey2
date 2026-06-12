import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";
import { getUserById, getUserLogs } from "@/lib/db";

/**
 * Audit-log entries for a user, newest first. Admin only — coaches never see
 * partner logs. Supports `?q=` (live search) and `?limit=` (the card shows 50;
 * the full-log view requests more).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;

  const { userId } = await params;
  const id = parseInt(userId, 10);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "Invalid user id" }, { status: 400 });
  }
  const user = await getUserById(id);
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? undefined;
  const limitParam = parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 1000) : 50;

  const logs = await getUserLogs(id, { q, limit });
  return NextResponse.json({ logs });
}
