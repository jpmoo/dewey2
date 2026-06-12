import { NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import { getUnreadThreadCount } from "@/lib/messages";

/** Number of the signed-in user's threads with unread messages. */
export async function GET() {
  const guard = await requireUser();
  if (guard instanceof NextResponse) return guard;
  const count = await getUnreadThreadCount(Number(guard.session.user.id));
  return NextResponse.json({ count });
}
