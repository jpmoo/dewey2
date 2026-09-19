import { NextRequest, NextResponse } from "next/server";
import { messageScope, requireUser } from "@/lib/guard";
import { canAccessThread } from "@/lib/messages";
import { getDeweyConversationTurns } from "@/lib/dewey-pane";
import { getPool } from "@/lib/pg";

export const runtime = "nodejs";

/** Expand a shared Dewey bubble: its snapshot turns, or the live conversation. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ threadId: string; messageId: string }> }
) {
  const guard = await requireUser();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  const { threadId, messageId } = await params;
  const id = parseInt(threadId, 10);
  const mid = parseInt(messageId, 10);
  if (!Number.isFinite(id) || !Number.isFinite(mid)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  const me = Number(session.user.id);
  const { isAdmin, overseeDistrictId } = messageScope(session);
  if (!(await canAccessThread(id, me, isAdmin, overseeDistrictId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const res = await getPool().query(
    "SELECT dewey_conversation_id, dewey_mode, dewey_summary, dewey_snapshot FROM messages WHERE id = $1 AND thread_id = $2 AND deleted_at IS NULL",
    [mid, id]
  );
  const row = res.rows[0];
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const mode = row.dewey_mode as "snapshot" | "live" | null;
  let turns: { role: string; content: string }[] = [];
  if (mode === "live" && row.dewey_conversation_id != null) {
    turns = await getDeweyConversationTurns(Number(row.dewey_conversation_id));
  } else if (Array.isArray(row.dewey_snapshot)) {
    turns = row.dewey_snapshot as { role: string; content: string }[];
  }
  return NextResponse.json({ mode, summary: row.dewey_summary ?? null, turns });
}
