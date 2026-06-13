import { getPool } from "@/lib/pg";
import {
  advanceActivity,
  decideSubmission,
  ensureSchema,
  getConsultTurns,
  getPhaseApprovedSubmissions,
  getSubmission,
  getTemplate,
  markActivitySubmission,
  userManagesThreadPlan,
  type ConsultTurn,
} from "@/lib/db";
import {
  getActiveActivity,
  getThreadMeta,
  logThreadEvent,
  postMessage,
  type AttachmentMeta,
} from "@/lib/messages";

/**
 * Activity submission + coach-review flow. A partner marks a chat message as the
 * active activity's submission; "Partner Attests" (OPEN) activities auto-complete
 * and advance (unless last in the phase), while "Coach Approves" (REVIEWED) — and
 * any last-in-phase activity — wait for a coach decision.
 */

export type SubmitResult =
  | { ok: true; pendingReview: boolean; advanced: boolean; finished: boolean }
  | { ok: false; error: string; status?: number };

export type ReviewResult =
  | { ok: true; decision: "approve" | "return"; advanced: boolean; finished: boolean }
  | { ok: false; error: string; status?: number };

/** Note posted by @dewey when the plan advances (factual progress, not a verdict). */
async function postAdvanceNote(
  threadId: number,
  planId: number,
  completedLabel: string,
  finished: boolean
): Promise<void> {
  let body: string;
  if (finished) {
    body = `🎉 "${completedLabel}" is complete — that was the final activity, so this plan is now finished.`;
  } else {
    const plan = await getTemplate(planId);
    const nextNode = (plan?.graph.nodes ?? []).find((n) => n.id === plan?.current_node_id);
    const nextLabel = nextNode?.label || nextNode?.activityKey || "the next activity";
    body = `✅ "${completedLabel}" is complete. The plan is now on "${nextLabel}".`;
  }
  await postMessage({
    threadId,
    senderId: null,
    isAi: true,
    body,
    event: finished ? "finish" : "advance",
  });
}

export interface SubmissionView {
  nodeLabel: string;
  partnerName: string | null;
  body: string;
  attachments: AttachmentMeta[];
}

export interface ReviewData {
  activity: {
    nodeLabel: string;
    instructions: string;
    artifact: string;
    gating: "OPEN" | "REVIEWED";
    phaseName: string | null;
    exitConditions: string | null;
    isLastInPhase: boolean;
  };
  submissionId: number;
  submission: SubmissionView | null;
  prior: SubmissionView[];
  consults: ConsultTurn[];
}

async function submissionView(
  nodeLabel: string,
  partnerId: number | null,
  messageId: number | null
): Promise<SubmissionView | null> {
  if (messageId == null) return null;
  const pool = getPool();
  const m = await pool.query(
    `SELECT mm.body, u.full_name AS partner_name
       FROM messages mm LEFT JOIN users u ON u.id = $2
      WHERE mm.id = $1 AND mm.deleted_at IS NULL`,
    [messageId, partnerId]
  );
  if (!m.rows[0]) return null;
  const a = await pool.query(
    "SELECT id, filename, mime_type, size_bytes FROM message_attachments WHERE message_id = $1 ORDER BY id",
    [messageId]
  );
  return {
    nodeLabel,
    partnerName: (m.rows[0].partner_name as string | null) ?? null,
    body: m.rows[0].body as string,
    attachments: a.rows.map((r) => ({
      id: Number(r.id),
      filename: r.filename as string,
      mime_type: r.mime_type as string,
      size_bytes: Number(r.size_bytes),
    })),
  };
}

/** Everything the coach's review modal renders. Null when nothing's pending. */
export async function getReviewData(threadId: number): Promise<ReviewData | null> {
  await ensureSchema();
  const active = await getActiveActivity(threadId);
  if (!active || !active.submission) return null;
  const sub = await getSubmission(active.submission.id);
  if (!sub) return null;
  const plan = await getTemplate(sub.plan_id);
  const graph = plan?.graph;

  const submission = await submissionView(active.nodeLabel, sub.partner_id, sub.message_id);

  const priorSubs = (await getPhaseApprovedSubmissions(sub.plan_id, sub.phase_id)).filter(
    (s) => s.node_id !== sub.node_id
  );
  const prior: SubmissionView[] = [];
  for (const s of priorSubs) {
    const node = (graph?.nodes ?? []).find((n) => n.id === s.node_id);
    const label = node?.label || node?.activityKey || s.node_id;
    const v = await submissionView(label, s.partner_id, s.message_id);
    if (v) prior.push(v);
  }

  return {
    activity: {
      nodeLabel: active.nodeLabel,
      instructions: active.instructions,
      artifact: active.artifact,
      gating: active.gating,
      phaseName: active.phaseName,
      exitConditions: active.exitConditions,
      isLastInPhase: active.isLastInPhase,
    },
    submissionId: sub.id,
    submission,
    prior,
    consults: await getConsultTurns(sub.id),
  };
}

export async function submitActivity(params: {
  threadId: number;
  partnerId: number;
  messageId: number;
}): Promise<SubmitResult> {
  await ensureSchema();
  const { threadId, partnerId, messageId } = params;

  const active = await getActiveActivity(threadId);
  if (!active) return { ok: false, error: "No activity is active in this conversation.", status: 400 };
  if (active.pendingReview) {
    return { ok: false, error: "A submission is already awaiting coach review.", status: 409 };
  }

  // The marking partner must own the message, and it must be in this thread.
  const pool = getPool();
  const msg = await pool.query(
    "SELECT sender_id FROM messages WHERE id = $1 AND thread_id = $2 AND deleted_at IS NULL",
    [messageId, threadId]
  );
  if (!msg.rows[0]) return { ok: false, error: "Message not found.", status: 404 };
  if (Number(msg.rows[0].sender_id) !== partnerId) {
    return { ok: false, error: "You can only submit your own messages.", status: 403 };
  }

  // OPEN mid-phase = self-attest → approve + advance now. Everything else waits
  // for the coach (REVIEWED, or any last-in-phase activity).
  const autoComplete = active.gating === "OPEN" && !active.isLastInPhase;
  await markActivitySubmission({
    planId: active.planId,
    nodeId: active.nodeId,
    phaseId: active.phaseId,
    partnerId,
    messageId,
    gating: active.gating,
    status: autoComplete ? "approved" : "pending",
  });

  if (autoComplete) {
    const adv = await advanceActivity(active.planId);
    await postAdvanceNote(threadId, active.planId, active.nodeLabel, adv.finished);
    await logThreadEvent({ userId: partnerId, actorId: partnerId, action: "activity_attested", threadId });
    await logThreadEvent({
      userId: partnerId,
      actorId: partnerId,
      action: adv.finished ? "plan_completed" : "plan_advanced",
      threadId,
    });
    return { ok: true, pendingReview: false, advanced: !adv.finished, finished: adv.finished };
  }

  await logThreadEvent({ userId: partnerId, actorId: partnerId, action: "activity_submitted", threadId });
  return { ok: true, pendingReview: true, advanced: false, finished: false };
}

export async function reviewActivity(params: {
  threadId: number;
  coachId: number;
  decision: "approve" | "return";
  feedback?: string;
}): Promise<ReviewResult> {
  await ensureSchema();
  const { threadId, coachId, decision, feedback } = params;

  const active = await getActiveActivity(threadId);
  if (!active || !active.submission || active.submission.status !== "pending") {
    return { ok: false, error: "There is no submission awaiting review.", status: 400 };
  }
  if (!(await userManagesThreadPlan(active.planId, coachId))) {
    return { ok: false, error: "Only a coach can review submissions.", status: 403 };
  }
  const submissionId = active.submission.id;
  const partnerId = active.submission.partnerId;

  if (decision === "approve") {
    await decideSubmission(submissionId, coachId, "approved");
    const adv = await advanceActivity(active.planId);
    await postAdvanceNote(threadId, active.planId, active.nodeLabel, adv.finished);
    await logThreadEvent({ userId: coachId, actorId: coachId, action: "activity_approved", threadId });
    if (adv.finished) {
      await logThreadEvent({ userId: coachId, actorId: coachId, action: "plan_completed", threadId });
    } else if (adv.crossedPhase) {
      await logThreadEvent({ userId: coachId, actorId: coachId, action: "phase_advanced", threadId });
    } else {
      await logThreadEvent({ userId: coachId, actorId: coachId, action: "plan_advanced", threadId });
    }
    return { ok: true, decision, advanced: !adv.finished, finished: adv.finished };
  }

  // Return with feedback: visible only to coaches + the receiving partner.
  const text = (feedback ?? "").trim();
  if (!text) return { ok: false, error: "Feedback is required to return a submission.", status: 400 };
  await decideSubmission(submissionId, coachId, "returned", text);

  const meta = await getThreadMeta(threadId);
  const coachIds = (meta?.participants ?? [])
    .filter((p) => p.system_role === "coach")
    .map((p) => p.id);
  const audience = Array.from(new Set([...coachIds, ...(partnerId != null ? [partnerId] : [])]));
  await postMessage({
    threadId,
    senderId: coachId,
    body: `↩️ Feedback on "${active.nodeLabel}":\n\n${text}`,
    audience,
  });
  await logThreadEvent({ userId: coachId, actorId: coachId, action: "activity_returned", threadId });
  return { ok: true, decision, advanced: false, finished: false };
}
