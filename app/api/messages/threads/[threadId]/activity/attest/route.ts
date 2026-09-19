import { NextRequest, NextResponse } from "next/server";
import { messageScope, requireUser } from "@/lib/guard";
import { canAccessThread } from "@/lib/messages";
import { attestActivity } from "@/lib/activity-flow";

/** The CoP Chair attests to the shared current activity, advancing the community. */
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
  const { isAdmin, overseeDistrictId } = messageScope(session);
  if (!(await canAccessThread(id, me, isAdmin, overseeDistrictId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const result = await attestActivity({ threadId: id, chairId: me });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status ?? 400 });
  }
  return NextResponse.json(result);
}
