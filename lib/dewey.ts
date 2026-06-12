import { chatComplete, complianceCheck } from "@/lib/ai";
import { ACTIVITY_TYPES, ACTIVITY_BY_KEY } from "@/lib/activities";
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
import type { TemplateGraph } from "@/lib/templates";

/**
 * The @dewey assistant inside the message center. When a participant mentions
 * @dewey, this runs the coaching model with the full conversation (and any
 * attached plan) as context, screens for compliance both ways, and posts a
 * reply as the AI participant. In a partnership it may, if asked, attach an
 * existing library plan or a custom plan it designs (owned by the coach).
 */

const ATTACH_MARKER = "===ATTACH===";
const GRAPH_MARKER = "===GRAPH===";

function buildSystemPrompt(library: { id: number; name: string; description: string | null }[]): string {
  const catalog = ACTIVITY_TYPES.map(
    (a) => `- ${a.key} — ${a.label} (${a.category})`
  ).join("\n");
  const lib = library.length
    ? library.map((p) => `- id ${p.id}: ${p.name}${p.description ? ` — ${p.description}` : ""}`).join("\n")
    : "(none)";
  return `You are @dewey, an AI coaching companion participating in a conversation on Dewey, a coaching platform for educators and school/district leaders. You can see the whole conversation and any plan attached to it.

Respond to the most recent message: answer the question or respond to the comment, concisely and helpfully, grounded in the conversation and the attached plan when relevant.

Only when explicitly asked to provide or build a plan:
- To attach an EXISTING plan from the coach's library, end your prose, then on a new line output exactly:
${ATTACH_MARKER}
followed by a single JSON object: {"sourcePlanId": <id from the library list>}
- To design a CUSTOM plan, end your prose, then on a new line output exactly:
${GRAPH_MARKER}
followed by a single JSON object:
{ "nodes": [ { "id": "n1", "activityKey": "<one of the keys below>", "gating": "OPEN"|"REVIEWED", "instructions": "<what the partner does>", "artifact": "<what they produce>", "phaseId": "p1"|null } ], "edges": [ { "source": "n1", "target": "n2" } ], "phases": [ { "id": "p1", "name": "<phase name>", "exitConditions": "<criteria>" } ] }

Rules:
- Do NOT output a marker or JSON unless the user asked you to choose or build a plan.
- Use ONLY activityKey values from the list. Never invent activities.
- Keep prose natural; do not mention these markers to the user.

Coach's plan library (for the attach option):
${lib}

Available activity types (for the custom-plan option):
${catalog}`;
}

function extractJson(s: string): unknown {
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Validate + lay out a model-proposed graph into a stable TemplateGraph. */
function sanitizeGraph(raw: unknown): TemplateGraph | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as { nodes?: unknown; edges?: unknown; phases?: unknown };
  const phasesIn = Array.isArray(obj.phases) ? obj.phases : [];
  const phases = phasesIn
    .map((p) => p as { id?: unknown; name?: unknown; exitConditions?: unknown })
    .filter((p) => typeof p.id === "string" && typeof p.name === "string")
    .map((p) => ({
      id: String(p.id),
      name: String(p.name),
      exitConditions: typeof p.exitConditions === "string" ? p.exitConditions : "",
    }));
  const phaseOrder = phases.map((p) => p.id);

  const nodesIn = Array.isArray(obj.nodes) ? obj.nodes : [];
  const perPhaseCount = new Map<string, number>();
  const nodes = nodesIn
    .map((n) => n as { id?: unknown; activityKey?: unknown; gating?: unknown; instructions?: unknown; artifact?: unknown; phaseId?: unknown })
    .filter((n) => typeof n.activityKey === "string" && ACTIVITY_BY_KEY[n.activityKey as string])
    .map((n, i) => {
      const key = n.activityKey as string;
      const def = ACTIVITY_BY_KEY[key];
      const phaseId = typeof n.phaseId === "string" && phaseOrder.includes(n.phaseId) ? n.phaseId : null;
      const col = phaseId ? phaseOrder.indexOf(phaseId) : phaseOrder.length;
      const row = perPhaseCount.get(phaseId ?? "_") ?? 0;
      perPhaseCount.set(phaseId ?? "_", row + 1);
      return {
        id: typeof n.id === "string" ? n.id : `n${i + 1}`,
        activityKey: key,
        label: def.label,
        position: { x: col * 340, y: row * 140 },
        phaseId,
        gating: (n.gating === "OPEN" ? "OPEN" : "REVIEWED") as "OPEN" | "REVIEWED",
        instructions: typeof n.instructions === "string" ? n.instructions : def.defaultInstructions,
        artifact: typeof n.artifact === "string" ? n.artifact : def.defaultArtifact,
      };
    });
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edgesIn = Array.isArray(obj.edges) ? obj.edges : [];
  const edges = edgesIn
    .map((e) => e as { source?: unknown; target?: unknown })
    .filter((e) => typeof e.source === "string" && typeof e.target === "string" && nodeIds.has(e.source as string) && nodeIds.has(e.target as string))
    .map((e, i) => ({ id: `e${i + 1}`, source: String(e.source), target: String(e.target) }));

  if (nodes.length === 0) return null;
  return { nodes, edges, phases } as TemplateGraph;
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

  const library = coachId ? await getTemplatesForCoach(coachId) : [];
  const system = buildSystemPrompt(library.map((p) => ({ id: p.id, name: p.name, description: p.description })));

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
      maxTokens: 2048,
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
    attach = extractJson(reply.slice(ai + ATTACH_MARKER.length));
  } else if (gi !== -1) {
    prose = reply.slice(0, gi).trim();
    graph = sanitizeGraph(extractJson(reply.slice(gi + GRAPH_MARKER.length)));
  }
  prose = prose.replace(/[:：]\s*$/, "").trim() || "Here you go.";

  // Outbound compliance on Dewey's prose.
  const outbound = await complianceCheck(prose);
  if (!outbound.allowed) prose = "I'm not able to help with that here.";

  await postMessage({ threadId, senderId: null, isAi: true, body: prose });

  // Plan directives only apply in partnerships (the coach owns the copy).
  if (outbound.allowed && isPartnership && coachId != null) {
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
