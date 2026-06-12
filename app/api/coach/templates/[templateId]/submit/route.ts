import { NextRequest, NextResponse } from "next/server";
import { requireCoach } from "@/lib/guard";
import { getAdminIds, getTemplateForCoach, logUserEvent } from "@/lib/db";
import { createThread, postMessage } from "@/lib/messages";

function parseId(s: string): number | null {
  const id = parseInt(s, 10);
  return Number.isFinite(id) ? id : null;
}

/**
 * Submit a personal template for consideration as a district-wide (global)
 * template. Opens an 'open' submission thread that surfaces in the admin
 * Templates panel for approve/reject, and gives the admin a place to reply.
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
  const message = typeof body.message === "string" ? body.message.trim() : "";

  const template = await getTemplateForCoach(id, coachId);
  if (!template) return NextResponse.json({ error: "Plan not found" }, { status: 404 });
  if (template.scope !== "personal") {
    return NextResponse.json(
      { error: "Only your own plans can be submitted." },
      { status: 400 }
    );
  }

  const senderName = session.user.nickname || session.user.name || "A coach";
  const threadId = await createThread({
    kind: "template_submission",
    subject: `Submission: ${template.name}`,
    templateId: id,
    status: "open",
    createdBy: coachId,
    // Admins read all threads via oversight; no need to list them as participants.
    participantIds: [],
  });
  await postMessage({
    threadId,
    senderId: coachId,
    body:
      message ||
      `${senderName} submitted the plan "${template.name}" for district-wide consideration.`,
  });
  // Touch every admin's awareness via the log too (subject = admin's own card).
  for (const adminId of await getAdminIds()) {
    await logUserEvent({
      userId: adminId,
      actorId: coachId,
      action: "template_submitted",
      detail: `by ${senderName}`,
      entityType: "template",
      entityId: id,
      entityLabel: template.name,
    });
  }
  return NextResponse.json({ ok: true, threadId });
}
