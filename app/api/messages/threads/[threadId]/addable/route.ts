import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import { getThreadAddableUsers } from "@/lib/messages";

/** Live @-search of users the requester may add to this thread. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ threadId: string }> }
) {
  const guard = await requireUser();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  const { threadId } = await params;
  const id = parseInt(threadId, 10);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  const q = new URL(request.url).searchParams.get("q") ?? "";
  const users = await getThreadAddableUsers(id, Number(session.user.id), q);
  return NextResponse.json({ users });
}
