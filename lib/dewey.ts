import { chatComplete, complianceCheck } from "@/lib/ai";
import { ACTIVITY_BY_KEY } from "@/lib/activities";
import { queryRagDefault, formatRagContext, uniqueSources } from "@/lib/rag";
import {
  createTemplate,
  deactivatePriorThreadPlans,
  duplicatePlanForPartnership,
  recordPlanAcceptance,
  getTemplate,
  getTemplatesForCoach,
  threadHasAcceptedPlan,
} from "@/lib/db";
import {
  getActiveActivity,
  getAttachmentTextsForThread,
  getThreadMessages,
  getThreadMeta,
  logThreadEvent,
  postMessage,
  reportComplianceFlag,
} from "@/lib/messages";
import {
  buildMessagePlanPrompt,
  sanitizeProposedGraph,
  extractJsonObject,
  GRAPH_MARKER,
  normalizeLeadInColon,
} from "@/lib/plan-ai";
import type { TemplateGraph } from "@/lib/templates";

/**
 * The @dewey assistant inside the message center. When a participant mentions
 * @dewey, this runs the coaching model with the full conversation (and any
 * attached plan) as context, screens for compliance both ways, and posts a
 * reply as the AI participant. In a partnership it may, if asked, attach an
 * existing library plan or a custom plan it designs (owned by the coach).
 *
 * Plan generation shares its prompt + sanitizer with the canvas assistant via
 * lib/plan-ai, so message-built plans match canvas-built ones in quality.
 */

const ATTACH_MARKER = "===ATTACH===";

/** Append/bump an "(edited)" suffix on a plan name when @dewey revises it. */
function nextEditedName(name: string): string {
  const m = name.match(/^(.*?)\s*\(edited(?: (\d+))?\)\s*$/);
  if (m) return `${m[1]} (edited ${m[2] ? Number(m[2]) + 1 : 2})`;
  return `${name} (edited)`;
}

function buildSystemPrompt(
  library: { id: number; name: string; description: string | null }[],
  allowPlans: boolean
): string {
  // Only the coach may have @dewey suggest/build a plan. For everyone else,
  // @dewey answers and comments but never proposes a plan.
  if (!allowPlans) {
    return `You are @dewey, an AI coaching companion participating in a conversation on Dewey, a coaching platform for educators and school/district leaders. You can see the whole conversation and any plan attached to it.

Respond to the most recent message: answer the question or respond to the comment, concisely and helpfully, grounded in the conversation and the attached plan when relevant.

Whenever it is relevant, steer participants toward the organization's own resources — especially its strategic plan, goals, priorities, initiatives, and other documents surfaced below. Connect their problem of practice to those strategic priorities and goals, point them to the specific document or section that speaks to it, and ground what you say in it (quote or paraphrase, and name the source). When the conversation drifts from what the organization has actually committed to, gently bring it back to those plans and goals.

You may answer questions and offer reflections, but do NOT propose, choose, or build a coaching plan in this conversation — only the coach can ask you to do that. If asked for a plan, suggest they ask their coach.`;
  }
  return buildMessagePlanPrompt(library, ATTACH_MARKER);
}

export async function runDeweyForThread(params: {
  threadId: number;
  invokerId: number;
  invokerName: string;
  invokerIsCoach: boolean;
  invokingMessage: string;
}): Promise<void> {
  const { threadId, invokerId, invokerName, invokerIsCoach, invokingMessage } = params;
  const meta = await getThreadMeta(threadId);
  if (!meta) return;
  // The invoking coach owns any plan @dewey attaches or builds.
  const coachId = invokerId;

  // Inbound compliance on the message that invoked @dewey.
  const inbound = await complianceCheck(invokingMessage);
  if (!inbound.allowed) {
    await reportComplianceFlag({
      userId: invokerId,
      userName: invokerName,
      flaggedMessage: invokingMessage,
      history: [],
      context: "messages (@dewey)",
    }).catch(() => {});
    await postMessage({
      threadId,
      senderId: null,
      isAi: true,
      body: "I can't respond to that — the message was flagged by the compliance screen. Try rephrasing it as a problem of practice.",
    });
    return;
  }

  // Context: the full transcript + the most recent attached plan, if any. Parsed
  // attachment text (uploaded files and typed documents) is woven in so @dewey
  // can read what participants attached.
  const history = await getThreadMessages(threadId);
  const attachTexts = await getAttachmentTextsForThread(threadId).catch(() => new Map());
  const transcript = history
    .map((m) => {
      if (m.plan_id) return `[Attached plan: ${m.plan_name ?? "plan"}]`;
      const who = m.is_ai ? "Dewey" : m.sender_name ?? "User";
      const docs = (attachTexts.get(m.id) ?? [])
        .map((a: { name: string; text: string }) => `\n[Attached document "${a.name}":\n${a.text}\n]`)
        .join("");
      return `${who}: ${m.body}${docs}`;
    })
    .join("\n");

  // Only a coach may have @dewey suggest or build a plan — and only while no plan
  // is locked in (a fully-accepted plan is final).
  const planLocked = await threadHasAcceptedPlan(threadId);
  const canSuggestPlans = invokerIsCoach && !planLocked;

  // The most-recently attached plan. When it's a coach-owned partnership copy we
  // pass the FULL graph JSON (like the canvas) so @dewey can faithfully revise it
  // in place when asked, and remember its id as the revision target.
  const lastPlanMsg = [...history].reverse().find((m) => m.plan_id);
  let planContext = "";
  let currentPlanId: number | null = null;
  if (lastPlanMsg?.plan_id) {
    const plan = await getTemplate(lastPlanMsg.plan_id);
    if (plan && !plan.deleted_at) {
      if (canSuggestPlans && plan.scope === "partnership" && plan.owner_id === coachId) {
        currentPlanId = plan.id;
        planContext = `\n\nThe plan currently attached to this conversation is "${plan.name}". Its full graph JSON (revise this if the coach asks you to adjust the plan):\n${JSON.stringify(plan.graph)}`;
      } else {
        planContext = `\n\nThe plan currently attached to this conversation ("${plan.name}") has these phases/activities:\n${plan.graph.phases
          .map((p) => `Phase ${p.name}: ${plan.graph.nodes.filter((n) => n.phaseId === p.id).map((n) => ACTIVITY_BY_KEY[n.activityKey]?.label ?? n.label).join(", ")}`)
          .join("\n")}`;
      }
    }
  }

  const library = canSuggestPlans ? await getTemplatesForCoach(coachId) : [];
  let system = buildSystemPrompt(
    library.map((p) => ({ id: p.id, name: p.name, description: p.description })),
    canSuggestPlans
  );

  // The activity the partner is currently working on (its prompt + expected
  // output). This frames feedback when a participant asks "what do you think of
  // my answer?" — Dewey can assess it against the activity's actual goal.
  const active = await getActiveActivity(threadId).catch(() => null);
  let activityContext = "";
  if (active) {
    const parts = [
      `\n\nThe partner is currently working on the activity "${active.nodeLabel}"${
        active.phaseName ? ` (phase "${active.phaseName}")` : ""
      }.`,
    ];
    if (active.instructions) parts.push(`Activity prompt: ${active.instructions}`);
    if (active.artifact) parts.push(`Expected output: ${active.artifact}`);
    if (active.exitConditions) parts.push(`Phase exit conditions: ${active.exitConditions}`);
    activityContext = parts.join("\n");
    system +=
      `\n\nA coaching activity is in progress (its prompt and expected output are in the conversation context). Stay tightly focused on THIS plan and THIS activity. Keep the partner inside the activity's purpose and do not run ahead of it: if the current activity is about understanding the current reality, surfacing a problem, interrogating assumptions, or setting a goal, then do NOT propose solutions, strategies, or action steps — even if asked directly (e.g. "what should I do?"). Instead, redirect with questions that advance the work of this specific activity. Only engage with solutions/strategies if the current activity is itself about choosing or planning them. Don't drift to other topics, other activities, or later phases of the plan.\n\nIf a participant shares their work for the activity or asks what you think of their answer, give specific, constructive formative feedback: weigh it against the activity's goal AND the organization's strategic plans, goals, and priorities (use the document excerpts below), name what's strong and where to push further, and point them to the relevant strategic resource. Do NOT tell the partner whether the activity is complete or that they're ready to advance — that judgment is the coach's alone.`;
  }

  // Ground in the org's documents via RAGDoll, like the canvas assistant does.
  // Retrieve against the activity's prompt/goal too (not just the latest message,
  // which is often terse like "what do you think?"), so the right strategic plans
  // and goals surface to guide feedback.
  // Include the latest attachment's text so retrieval reflects uploaded content.
  const latestAttach = [...history]
    .reverse()
    .map((m) => attachTexts.get(m.id))
    .find((a): a is { name: string; text: string }[] => Array.isArray(a) && a.length > 0);
  const ragQuery = [
    active?.nodeLabel,
    active?.instructions,
    invokingMessage,
    latestAttach?.[0]?.text?.slice(0, 2000),
  ]
    .filter(Boolean)
    .join("\n");
  const chunks = await queryRagDefault(ragQuery).catch(() => []);
  const sources = uniqueSources(chunks);
  if (chunks.length > 0) {
    system +=
      "\n\nRelevant excerpts from the organization's documents (strategic plans, goals, priorities, frameworks, etc.). Actively steer the conversation toward these: ground your response in them, reference the specific document/section by name, and help participants connect their work to the organization's stated strategic plans and goals. Prefer these official sources over generic advice.\n" +
      formatRagContext(chunks);
  }

  let reply = "";
  try {
    const result = await chatComplete({
      system,
      messages: [
        {
          role: "user",
          content: `Conversation so far:\n${transcript}${planContext}${activityContext}\n\nRespond to the most recent message.`,
        },
      ],
      maxTokens: 4096,
    });
    reply = result.text;
  } catch (e) {
    await postMessage({
      threadId,
      senderId: null,
      isAi: true,
      body: "Sorry — I couldn't reach the model just now. Please try again.",
    });
    console.warn("[dewey] model call failed", e instanceof Error ? e.message : e);
    return;
  }

  // Split prose from any plan directive. Markers are matched case-insensitively
  // and tolerant of stray spaces (===GRAPH=== / === graph ===).
  const attachRe = /={2,}\s*attach\s*={2,}/i;
  const graphRe = /={2,}\s*graph\s*={2,}/i;
  const am = reply.match(attachRe);
  const gm = reply.match(graphRe);
  const ai = am?.index ?? -1;
  const gi = gm?.index ?? -1;
  let prose = reply;
  let attach: unknown = null;
  let graph: TemplateGraph | null = null;
  if (ai !== -1) {
    prose = reply.slice(0, ai).trim();
    attach = extractJsonObject(reply.slice(ai + (am?.[0].length ?? 0)));
  } else if (gi !== -1) {
    prose = reply.slice(0, gi).trim();
    graph = sanitizeProposedGraph(extractJsonObject(reply.slice(gi + (gm?.[0].length ?? 0))));
  } else if (canSuggestPlans) {
    // The model sometimes forgets the marker but still includes the JSON. If a
    // plan-shaped object is present, treat it as the directive so the coach's
    // request isn't silently dropped (the "Here's a plan" with nothing bug).
    const obj = extractJsonObject(reply);
    const jsonStart = reply.indexOf("{");
    if (obj && (Array.isArray((obj as { nodes?: unknown }).nodes) || Array.isArray((obj as { phases?: unknown }).phases))) {
      graph = sanitizeProposedGraph(obj);
      if (graph && jsonStart > 0) prose = reply.slice(0, jsonStart).trim();
    } else if (obj && (obj as { sourcePlanId?: unknown }).sourcePlanId != null) {
      attach = obj;
      if (jsonStart > 0) prose = reply.slice(0, jsonStart).trim();
    }
  }
  // A plan lead-in should end with an ellipsis, not a colon — normalize either way.
  prose = normalizeLeadInColon(prose).trim() || "Here you go.";

  // If the model emitted a plan directive but we couldn't build a plan from it,
  // tell the coach instead of leaving a bare "Here's a plan" with nothing.
  const planFailed = canSuggestPlans && !graph && !attach && (gi !== -1 || ai !== -1);
  if (planFailed) {
    prose +=
      "\n\n_(I couldn't format that as a plan just now. Ask me to \"build the plan\" and I'll attach it to the conversation.)_";
  }
  if (canSuggestPlans) {
    console.info(
      `[dewey] plan parse: attachMarker=${ai !== -1} graphMarker=${gi !== -1} graph=${
        graph ? graph.nodes.length + "n/" + graph.phases.length + "p" : "null"
      } attach=${attach ? "yes" : "no"} failed=${planFailed}`
    );
  }

  // Outbound compliance on Dewey's prose.
  const outbound = await complianceCheck(prose);
  if (!outbound.allowed) prose = "I'm not able to help with that here.";

  await postMessage({
    threadId,
    senderId: null,
    isAi: true,
    body: prose,
    sources: outbound.allowed ? sources : null,
  });

  // Plan directives only apply when the coach invoked @dewey (they own the copy).
  if (outbound.allowed && canSuggestPlans && coachId != null) {
    if (attach && typeof attach === "object") {
      const sourceId = Number((attach as { sourcePlanId?: unknown }).sourcePlanId);
      if (library.some((p) => p.id === sourceId)) {
        const copy = await duplicatePlanForPartnership(sourceId, coachId, threadId);
        if (copy) {
          await deactivatePriorThreadPlans(threadId, copy.id);
          await postMessage({
            threadId,
            senderId: null,
            isAi: true,
            body: `I've attached the plan "${copy.name}". The coach can edit or dismiss it.`,
            planId: copy.id,
          });
          await recordPlanAcceptance(copy.id, coachId);
          await logThreadEvent({ userId: invokerId, actorId: invokerId, action: "plan_added", threadId, detail: "via @dewey" });
        }
      }
    } else if (graph && currentPlanId != null) {
      // Adjusting an attached plan creates a NEW edited version and supersedes the
      // old one (so the prior card grays out), rather than mutating in place.
      const base = await getTemplate(currentPlanId);
      const copy = await createTemplate({
        name: nextEditedName(base?.name ?? "Plan from @dewey"),
        description: base?.description ?? "Drafted by @dewey in a conversation.",
        graph,
        createdBy: coachId,
        scope: "partnership",
        ownerId: coachId,
        threadId,
      });
      await deactivatePriorThreadPlans(threadId, copy.id);
      await postMessage({
        threadId,
        senderId: null,
        isAi: true,
        body: `I've updated the plan — here's "${copy.name}". Accept, edit, or dismiss it.`,
        planId: copy.id,
      });
      await recordPlanAcceptance(copy.id, coachId);
      await logThreadEvent({ userId: invokerId, actorId: invokerId, action: "plan_edited", threadId, detail: "via @dewey" });
    } else if (graph) {
      const copy = await createTemplate({
        name: "Plan from @dewey",
        description: "Drafted by @dewey in a message thread conversation.",
        graph,
        createdBy: coachId,
        scope: "partnership",
        ownerId: coachId,
        threadId,
      });
      await deactivatePriorThreadPlans(threadId, copy.id);
      await postMessage({
        threadId,
        senderId: null,
        isAi: true,
        body: `I've drafted a custom plan, "${copy.name}". The coach can edit or dismiss it.`,
        planId: copy.id,
      });
      await recordPlanAcceptance(copy.id, coachId);
      await logThreadEvent({ userId: invokerId, actorId: invokerId, action: "plan_added", threadId, detail: "drafted by @dewey" });
    }
  }

  await logThreadEvent({ userId: invokerId, actorId: invokerId, action: "dewey_replied", threadId });
}

/** Whether a message body mentions @dewey. */
export function mentionsDewey(body: string): boolean {
  return /(^|\s)@dewey\b/i.test(body);
}
