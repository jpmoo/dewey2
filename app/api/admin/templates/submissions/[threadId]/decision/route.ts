import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";
import { logUserEvent, publishTemplateAsGlobal } from "@/lib/db";
import { addParticipant, getThreadMeta, postMessage, setThreadStatus } from "@/lib/messages";

function parseId(s: string): number | null {
  const id = parseInt(s, 10);
  return Number.isFinite(id) ? id : null;
}

/**
 * Approve or reject a template submission. Approval publishes the coach's
 * template as a global one; either way the admin's reply is posted to the
 * submission thread so the coach sees the decision.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ threadId: string }> }
) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  const adminId = Number(session.user.id);
  const { threadId } = await params;
  const tid = parseId(threadId);
  if (tid === null) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const body = await request.json().catch(() => ({}));
  const decision = body.decision === "approve" ? "approve" : body.decision === "reject" ? "reject" : null;
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!decision) return NextResponse.json({ error: "Invalid decision" }, { status: 400 });

  const thread = await getThreadMeta(tid);
  if (!thread || thread.kind !== "template_submission") {
    return NextResponse.json({ error: "Submission not found" }, { status: 404 });
  }
  if (thread.status !== "open") {
    return NextResponse.json({ error: "This submission was already decided." }, { status: 409 });
  }

  const adminName = session.user.nickname || session.user.name || "Admin";

  if (decision === "approve") {
    if (thread.template_id == null || !(await publishTemplateAsGlobal(thread.template_id))) {
      return NextResponse.json(
        { error: "The plan is no longer available to publish." },
        { status: 409 }
      );
    }
    await setThreadStatus(tid, "approved");
  } else {
    await setThreadStatus(tid, "rejected");
  }

  // The admin joins the thread and replies with the decision.
  await addParticipant(tid, adminId);
  const verdict = decision === "approve" ? "approved ✓" : "not approved";
  await postMessage({
    threadId: tid,
    senderId: adminId,
    body: message
      ? `${adminName}: ${message}`
      : `${adminName} marked this submission ${verdict}.`,
  });

  if (thread.template_id != null) {
    await logUserEvent({
      userId: adminId,
      actorId: adminId,
      action: decision === "approve" ? "template_approved" : "template_rejected",
      detail: thread.template_name ?? undefined,
      entityType: "template",
      entityId: thread.template_id,
      entityLabel: thread.template_name ?? null,
    });
  }
  return NextResponse.json({ ok: true });
}
