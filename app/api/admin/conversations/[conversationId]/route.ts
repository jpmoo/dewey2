import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";
import { getConversation, getMessages } from "@/lib/ai-chat";

/** Full transcript of one AI conversation. Admin only. */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;
  const { conversationId } = await params;
  const id = parseInt(conversationId, 10);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const conversation = await getConversation(id);
  if (!conversation) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const messages = await getMessages(id);
  return NextResponse.json({
    conversation: { id: conversation.id, summary: conversation.summary },
    messages,
  });
}
