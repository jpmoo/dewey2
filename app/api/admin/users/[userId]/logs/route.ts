import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";
import { getUserById, getUserLogs } from "@/lib/db";

/** Recent audit-log entries for a user, newest first. Admin only. */
export async function GET(
  _request: NextRequest,
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

  const logs = await getUserLogs(id);
  return NextResponse.json({ logs });
}
