import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";
import { listConversationsForOwner } from "@/lib/ai-chat";

/** A user's saved AI conversations (transcripts). Admin only. */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;
  const { userId } = await params;
  const id = parseInt(userId, 10);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  const conversations = await listConversationsForOwner(id);
  return NextResponse.json({ conversations });
}
