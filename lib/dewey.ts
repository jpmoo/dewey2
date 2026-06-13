import { chatComplete, complianceCheck } from "@/lib/ai";
import { ACTIVITY_BY_KEY } from "@/lib/activities";
import { queryRagDefault, formatRagContext } from "@/lib/rag";
import {
  createTemplate,
  duplicatePlanForPartnership,
  getTemplate,
  getTemplatesForCoach,
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
  invokingMessage: string;
}): Promise<void> {
  const { threadId, invokerId, invokerName, invokingMessage } = params;
  const meta = await getThreadMeta(threadId);
  if (!meta) return;
  const isPartnership = meta.kind === "partnership";
  const coachId = meta.created_by; // plan owner, when present

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

  const lastPlanMsg = [...history].reverse().find((m) => m.plan_id);
  let planContext = "";
  if (lastPlanMsg?.plan_id) {
    const plan = await getTemplate(lastPlanMsg.plan_id);
    if (plan) {
      planContext = `\n\nThe plan currently attached to this conversation ("${plan.name}") has these phases/activities:\n${plan.graph.phases
        .map((p) => `Phase ${p.name}: ${plan.graph.nodes.filter((n) => n.phaseId === p.id).map((n) => ACTIVITY_BY_KEY[n.activityKey]?.label ?? n.label).join(", ")}`)
        .join("\n")}`;
    }
  }

  // Only the coach (thread creator) may have @dewey suggest or build a plan.
  const canSuggestPlans = isPartnership && coachId != null && coachId === invokerId;
  const library = canSuggestPlans ? await getTemplatesForCoach(coachId) : [];
  let system = buildSystemPrompt(
    library.map((p) => ({ id: p.id, name: p.name, description: p.description })),
    canSuggestPlans
  );

  // Ground in the org's documents via RAGDoll, like the canvas assistant does,
  // so message-built plans are as well-grounded as canvas-built ones.
  const chunks = await queryRagDefault(invokingMessage).catch(() => []);
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

  // Split prose from any plan directive.
  const ai = reply.indexOf(ATTACH_MARKER);
  const gi = reply.indexOf(GRAPH_MARKER);
  let prose = reply;
  let attach: unknown = null;
  let graph: TemplateGraph | null = null;
  if (ai !== -1) {
    prose = reply.slice(0, ai).trim();
    attach = extractJsonObject(reply.slice(ai + ATTACH_MARKER.length));
  } else if (gi !== -1) {
    prose = reply.slice(0, gi).trim();
    graph = sanitizeProposedGraph(extractJsonObject(reply.slice(gi + GRAPH_MARKER.length)));
  }
  prose = prose.replace(/[:：]\s*$/, "").trim() || "Here you go.";

  // Outbound compliance on Dewey's prose.
  const outbound = await complianceCheck(prose);
  if (!outbound.allowed) prose = "I'm not able to help with that here.";

  await postMessage({ threadId, senderId: null, isAi: true, body: prose });

  // Plan directives only apply when the coach invoked @dewey (they own the copy).
  if (outbound.allowed && canSuggestPlans && coachId != null) {
    if (attach && typeof attach === "object") {
      const sourceId = Number((attach as { sourcePlanId?: unknown }).sourcePlanId);
      if (library.some((p) => p.id === sourceId)) {
        const copy = await duplicatePlanForPartnership(sourceId, coachId, threadId);
        if (copy) {
          await postMessage({
            threadId,
            senderId: null,
            isAi: true,
            body: `I've attached the plan "${copy.name}". The coach can edit or dismiss it.`,
            planId: copy.id,
          });
        }
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
      await postMessage({
        threadId,
        senderId: null,
        isAi: true,
        body: `I've drafted a custom plan, "${copy.name}". The coach can edit or dismiss it.`,
        planId: copy.id,
      });
    }
  }

  await logThreadEvent({ userId: invokerId, actorId: invokerId, action: "dewey_replied", threadId });
}

/** Whether a message body mentions @dewey. */
export function mentionsDewey(body: string): boolean {
  return /(^|\s)@dewey\b/i.test(body);
}
