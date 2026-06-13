import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import { canAccessThread } from "@/lib/messages";
import { withdrawActivity } from "@/lib/activity-flow";

/** A partner withdraws their own pending submission before the coach reviews it. */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ threadId: string }> }
) {
  const guard = await requireUser();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  const { threadId } = await params;
  const id = parseInt(threadId, 10);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const me = Number(session.user.id);
  const isAdmin = session.user.system_role === "admin";
  if (!(await canAccessThread(id, me, isAdmin))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const result = await withdrawActivity({ threadId: id, partnerId: me });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status ?? 400 });
  }
  return NextResponse.json(result);
}
