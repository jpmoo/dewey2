import { NextRequest, NextResponse } from "next/server";
import { requireCoach } from "@/lib/guard";
import { getMessageRecipients } from "@/lib/db";
import { getSystemSettings } from "@/lib/settings";
import { createPartnership, logThreadEvent } from "@/lib/messages";

/**
 * Create a partnership: a coach invites one or more partners. Opens a
 * partnership thread (coach auto-accepted, partners invited with a yes/no).
 */
export async function POST(request: NextRequest) {
  const guard = await requireCoach();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  const coachId = Number(session.user.id);

  const body = await request.json().catch(() => ({}));
  const rawIds: unknown[] = Array.isArray(body.partnerIds) ? body.partnerIds : [];
  const partnerIds = Array.from(
    new Set(rawIds.map((v) => Number(v)).filter((n) => Number.isFinite(n) && n !== coachId))
  );
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (partnerIds.length === 0) {
    return NextResponse.json({ error: "Choose at least one partner" }, { status: 400 });
  }
  if (message.length < 10) {
    return NextResponse.json(
      { error: "Add a description (at least a sentence) so the partnership can be named." },
      { status: 400 }
    );
  }

  // Every invitee must be someone the coach is allowed to message.
  const settings = await getSystemSettings();
  const allowed = new Set((await getMessageRecipients(coachId, settings.message_permissions)).map((r) => r.id));
  if (!partnerIds.every((id) => allowed.has(id))) {
    return NextResponse.json({ error: "You can't invite one of those people" }, { status: 403 });
  }

  const threadId = await createPartnership(coachId, partnerIds, message);
  await logThreadEvent({
    userId: coachId,
    actorId: coachId,
    action: "partnership_created",
    threadId,
    detail: `${partnerIds.length} partner(s)`,
  });
  return NextResponse.json({ ok: true, threadId });
}
