import { chatComplete, complianceCheck } from "@/lib/ai";
import { ACTIVITY_BY_KEY } from "@/lib/activities";
import { queryRagDefault, formatRagContext, uniqueSources } from "@/lib/rag";
import {
  createTemplate,
  deactivatePriorThreadPlans,
  duplicatePlanForPartnership,
  getTemplate,
  getTemplatesForCoach,
  revisePartnershipPlan,
  threadHasAcceptedPlan,
} from "@/lib/db";
import {
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

function buildSystemPrompt(
  library: { id: number; name: string; description: string | null }[],
  allowPlans: boolean
): string {
  // Only the coach may have @dewey suggest/build a plan. For everyone else,
  // @dewey answers and comments but never proposes a plan.
  if (!allowPlans) {
    return `You are @dewey, an AI coaching companion participating in a conversation on Dewey, a coaching platform for educators and school/district leaders. You can see the whole conversation and any plan attached to it.

Respond to the most recent message: answer the question or respond to the comment, concisely and helpfully, grounded in the conversation and the attached plan when relevant.

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

  // Context: the full transcript + the most recent attached plan, if any.
  const history = await getThreadMessages(threadId);
  const transcript = history
    .map((m) => {
      if (m.plan_id) return `[Attached plan: ${m.plan_name ?? "plan"}]`;
      const who = m.is_ai ? "Dewey" : m.sender_name ?? "User";
      return `${who}: ${m.body}`;
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

  // Ground in the org's documents via RAGDoll, like the canvas assistant does,
  // so message-built plans are as well-grounded as canvas-built ones.
  const chunks = await queryRagDefault(invokingMessage).catch(() => []);
  const sources = uniqueSources(chunks);
  if (chunks.length > 0) {
    system +=
      "\n\nRelevant excerpts from the organization's documents — ground your suggestions in these where applicable:\n" +
      formatRagContext(chunks);
  }

  let reply = "";
  try {
    const result = await chatComplete({
      system,
      messages: [
        {
          role: "user",
          content: `Conversation so far:\n${transcript}${planContext}\n\nRespond to the most recent message.`,
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
  prose = prose.replace(/[:：]\s*$/, "").trim() || "Here you go.";

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
          await logThreadEvent({ userId: invokerId, actorId: invokerId, action: "plan_added", threadId, detail: "via @dewey" });
        }
      }
    } else if (graph && currentPlanId != null) {
      // A plan is already attached — revise it in place (like the canvas does).
      const updated = await revisePartnershipPlan(currentPlanId, coachId, graph);
      if (updated) {
        await postMessage({
          threadId,
          senderId: null,
          isAi: true,
          body: `I've updated the plan "${updated.name}". Re-accept, edit, or dismiss it.`,
          planId: updated.id,
        });
        await logThreadEvent({ userId: invokerId, actorId: invokerId, action: "plan_edited", threadId, detail: "via @dewey" });
      }
    } else if (graph) {
      const copy = await createTemplate({
        name: "Plan from @dewey",
        description: "Drafted by @dewey in a partnership conversation.",
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
      await logThreadEvent({ userId: invokerId, actorId: invokerId, action: "plan_added", threadId, detail: "drafted by @dewey" });
    }
  }

  await logThreadEvent({ userId: invokerId, actorId: invokerId, action: "dewey_replied", threadId });
}

/** Whether a message body mentions @dewey. */
export function mentionsDewey(body: string): boolean {
  return /(^|\s)@dewey\b/i.test(body);
}
