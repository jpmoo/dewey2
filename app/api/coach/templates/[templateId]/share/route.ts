import { NextRequest, NextResponse } from "next/server";
import { requireCoach } from "@/lib/guard";
import { getCoachesInDistrict, getTemplateForCoach, logUserEvent } from "@/lib/db";
import { createThread, postMessage } from "@/lib/messages";

function parseId(s: string): number | null {
  const id = parseInt(s, 10);
  return Number.isFinite(id) ? id : null;
}

/**
 * Share a template the coach can see with another coach in their district.
 * Opens a thread (visible to both) seeded with the coach's message.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ templateId: string }> }
) {
  const guard = await requireCoach();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  const coachId = Number(session.user.id);
  const { templateId } = await params;
  const id = parseId(templateId);
  if (id === null) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const body = await request.json().catch(() => ({}));
  const recipientId = Number(body.recipientId);
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!Number.isFinite(recipientId)) {
    return NextResponse.json({ error: "Choose a coach to share with" }, { status: 400 });
  }

  const template = await getTemplateForCoach(id, coachId);
  if (!template) return NextResponse.json({ error: "Plan not found" }, { status: 404 });

  // Recipient must be a coach in the sender's district.
  const recipient = (await getCoachesInDistrict(coachId)).find((c) => c.id === recipientId);
  if (!recipient) {
    return NextResponse.json({ error: "That coach isn't available to share with" }, { status: 400 });
  }

  const senderName = session.user.nickname || session.user.name || "A coach";
  const threadId = await createThread({
    kind: "template_share",
    subject: `Shared plan: ${template.name}`,
    templateId: id,
    createdBy: coachId,
    participantIds: [recipientId],
  });
  await postMessage({
    threadId,
    senderId: coachId,
    body: message || `${senderName} shared the plan "${template.name}" with you.`,
  });

  await logUserEvent({
    userId: coachId,
    actorId: coachId,
    action: "template_shared",
    detail: `to ${recipient.full_name}`,
    entityType: "template",
    entityId: id,
    entityLabel: template.name,
  });
  return NextResponse.json({ ok: true, threadId });
}
