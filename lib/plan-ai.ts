import { ACTIVITY_TYPES, ACTIVITY_BY_KEY } from "@/lib/activities";
import type { TemplateGraph } from "@/lib/templates";

/**
 * Shared plan-generation core used by BOTH the canvas assistant
 * (app/api/admin/templates/assistant) and the @dewey message assistant
 * (lib/dewey). Extracted so the two paths produce graphs of identical quality.
 *
 * The canvas path was the reference implementation; its prompt and sanitizer are
 * reproduced here verbatim (see buildCanvasPlanPrompt / sanitizeProposedGraph) so
 * the canvas behaves byte-for-byte as before. The message path now reuses the
 * same sanitizer and the same activity catalog, with a chat-framed prompt that
 * adds the "attach an existing library plan" option.
 */

export const PHASE_COLORS = ["#2563eb", "#16a34a", "#9333ea", "#ea580c", "#0891b2", "#db2777"];

// Marker separating the conversational reply from the proposed graph JSON.
export const GRAPH_MARKER = "===GRAPH===";

// Activity catalog WITH default gating — the richer form the canvas always used.
const CATALOG_WITH_GATING = ACTIVITY_TYPES.map(
  (a) => `- ${a.key} — ${a.label} (category: ${a.category}, default gating: ${a.defaultGating})`
).join("\n");

const GRAPH_JSON_SHAPE = `{ "nodes": [ { "id": "n1", "activityKey": "<one of the keys below>", "gating": "OPEN"|"REVIEWED", "instructions": "<what the partner does>", "artifact": "<what the partner produces>", "phaseId": "p1"|null } ], "edges": [ { "source": "n1", "target": "n2" } ], "phases": [ { "id": "p1", "name": "<phase name>", "exitConditions": "<criteria>" } ] }`;

/**
 * The canvas assistant's system prompt — reproduced verbatim so the canvas
 * generator is unchanged. Do not alter this without intending to change canvas
 * behavior.
 */
export function buildCanvasPlanPrompt(): string {
  return `You are an assistant embedded in Dewey, a coaching platform for educators and school/district leaders, helping a coach or admin build a reusable coaching PLAN on a canvas. The person being coached (the "partner") may be a teacher or other educator, an instructional coach, or a school/district leader — keep suggestions applicable across these roles rather than assuming a leadership position.

Model: Arc → Phase → Activity.
- An Activity is a unit of work, drawn from a FIXED taxonomy (use only the exact keys listed below).
- A Phase bundles activities and has EXIT CONDITIONS: criteria the AI evaluates once all the phase's activities are done, surfaced to the coach before they approve advancement (distinct from an activity's done-state/gating).
- Edges indicate flow between activities (source = previous, target = next).

You can:
1. Answer questions about the current plan graph.
2. Suggest activity instructions (descriptions) and phase exit conditions.
3. Create or revise an arc of phases and activities from a description.

RESPONSE FORMAT:
- First write a brief conversational reply to the admin, in plain prose.
- If (and ONLY if) you are proposing concrete additions/changes to the canvas, end that prose reply with a colon (e.g. "Here's the arc I'd build:") and then, on the next line, output a line containing exactly:
${GRAPH_MARKER}
followed by a single JSON object:
${GRAPH_JSON_SHAPE}
- For questions or advice with no canvas change, do NOT output the marker or any JSON.

Rules:
- Use ONLY activityKey values from the list below. Never invent new activities or keys; the activity taxonomy is fixed.
- Do NOT provide labels — each activity's label is fixed by its type.
- Give each node a unique id; reference phases by the ids you define in "phases".
- Do NOT include positions/coordinates — the canvas lays activities out automatically.

Available activity types:
${CATALOG_WITH_GATING}`;
}

/**
 * The @dewey message assistant's plan prompt. Mirrors the canvas guidance (same
 * model, same taxonomy with gating, same graph JSON, same fill-everything-in
 * expectations) but framed for a chat and with the option to attach an existing
 * library plan instead of designing a new one.
 */
export function buildMessagePlanPrompt(
  library: { id: number; name: string; description: string | null }[],
  attachMarker: string
): string {
  const lib = library.length
    ? library.map((p) => `- id ${p.id}: ${p.name}${p.description ? ` — ${p.description}` : ""}`).join("\n")
    : "(none)";
  return `You are @dewey, an AI coaching companion participating in a conversation on Dewey, a coaching platform for educators and school/district leaders. You can see the whole conversation and any plan attached to it.

Model: Arc → Phase → Activity.
- An Activity is a unit of work, drawn from a FIXED taxonomy (use only the exact keys listed below).
- A Phase bundles activities and has EXIT CONDITIONS: criteria evaluated once all the phase's activities are done, surfaced to the coach before they approve advancement (distinct from an activity's done-state/gating).
- Edges indicate flow between activities (source = previous, target = next).

When the coach asks you for a plan, an arc, a template, or to build/draft/design/suggest/create one, you MUST actually produce it in this same reply — do NOT just ask for more information, and do NOT promise to build it later. Make reasonable assumptions from the conversation (the partner, their goal, the topic) and design a COMPLETE, well-connected arc. Only ask a single clarifying question if the request is genuinely impossible to act on.

There are two ways to deliver a plan:
- If an EXISTING plan in the coach's library clearly fits, attach it: write a one-sentence reply, then on a new line output exactly:
${attachMarker}
followed by a single JSON object: {"sourcePlanId": <id from the library list>}
- Otherwise DESIGN a custom arc: write a one- or two-sentence reply, then on a new line output exactly:
${GRAPH_MARKER}
followed by a single JSON object:
${GRAPH_JSON_SHAPE}
Prefer DESIGNING a custom arc unless an existing library plan is an obvious match.

Quality bar (match a hand-built canvas plan):
- Design a substantial, coherent arc — typically 3-5 phases, each with the activities it genuinely needs (often 2-4), not a token one or two.
- Write real, specific "instructions" and "artifact" text for EVERY activity, and concrete "exitConditions" for EVERY phase — never leave them blank.
- CONNECT the activities with edges in execution order: every activity should sit on a path (source → target), and phases should flow one into the next. Do not emit isolated, unconnected nodes.
- Choose gating per activity (OPEN = partner self-attests; REVIEWED = coach approves); use the activity's default when unsure.

Rules:
- When asked for a plan/arc/template, ALWAYS end with one of the two marker blocks above — never reply with only prose in that case.
- Do NOT output a marker or JSON when the coach is only chatting and did not ask for a plan.
- Use ONLY activityKey values from the list. Never invent activities or keys.
- Give each node a unique id; reference phases by the ids you define in "phases". Do NOT include positions/coordinates.
- Keep the prose to a sentence or two; do not paste the JSON into the prose or mention the markers.

Coach's plan library (for the attach option):
${lib}

Available activity types (use these activityKey values):
${CATALOG_WITH_GATING}`;
}

interface ProposedNode {
  id: string;
  activityKey: string;
  label: string;
  gating: "OPEN" | "REVIEWED";
  instructions: string;
  artifact: string;
  phaseId: string | null;
  position: { x: number; y: number };
}

/**
 * Validate + normalize a model-proposed graph: drop unknown activities, fill
 * ids/colors/defaults, lay out. Reproduced verbatim from the canvas assistant.
 */
export function sanitizeProposedGraph(raw: unknown): TemplateGraph | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  const phasesIn = Array.isArray(obj.phases) ? obj.phases : [];
  const phases = phasesIn.map((p, idx) => {
    const po = (p ?? {}) as Record<string, unknown>;
    return {
      id: typeof po.id === "string" && po.id ? po.id : `p_${idx + 1}`,
      name: typeof po.name === "string" && po.name ? po.name : `Phase ${idx + 1}`,
      color: PHASE_COLORS[idx % PHASE_COLORS.length],
      exitConditions: typeof po.exitConditions === "string" ? po.exitConditions : undefined,
    };
  });
  const phaseIds = new Set(phases.map((p) => p.id));

  const nodesIn = Array.isArray(obj.nodes) ? obj.nodes : [];
  const nodes: ProposedNode[] = [];
  let autoId = 0;
  for (const n of nodesIn) {
    const no = (n ?? {}) as Record<string, unknown>;
    const key = typeof no.activityKey === "string" ? no.activityKey : "";
    const def = ACTIVITY_BY_KEY[key];
    if (!def) continue; // drop unknown activity types
    const phaseId =
      typeof no.phaseId === "string" && phaseIds.has(no.phaseId) ? no.phaseId : null;
    nodes.push({
      id: typeof no.id === "string" && no.id ? no.id : `n_${++autoId}`,
      activityKey: key,
      label: def.label, // labels are fixed by activity type
      gating: no.gating === "OPEN" || no.gating === "REVIEWED" ? no.gating : def.defaultGating,
      instructions:
        typeof no.instructions === "string" && no.instructions
          ? no.instructions
          : def.defaultInstructions,
      artifact:
        typeof no.artifact === "string" && no.artifact ? no.artifact : def.defaultArtifact,
      phaseId,
      position: { x: 0, y: 0 },
    });
  }

  // Lay out: phases become columns (in order), unphased nodes in a trailing column.
  const colOf = new Map<string, number>();
  phases.forEach((p, i) => colOf.set(p.id, i));
  const unphasedCol = phases.length;
  const rowByCol: Record<number, number> = {};
  // Wide column spacing so each phase's cloud has a clear buffer from the next.
  const COL_GAP = 340;
  for (const n of nodes) {
    const col = n.phaseId != null && colOf.has(n.phaseId) ? (colOf.get(n.phaseId) as number) : unphasedCol;
    const row = rowByCol[col] ?? 0;
    rowByCol[col] = row + 1;
    n.position = { x: 60 + col * COL_GAP, y: 90 + row * 110 };
  }

  const nodeIds = new Set(nodes.map((n) => n.id));
  const edgesIn = Array.isArray(obj.edges) ? obj.edges : [];
  const edges: { id: string; source: string; target: string }[] = [];
  let edgeId = 0;
  for (const e of edgesIn) {
    const eo = (e ?? {}) as Record<string, unknown>;
    const source = typeof eo.source === "string" ? eo.source : "";
    const target = typeof eo.target === "string" ? eo.target : "";
    if (nodeIds.has(source) && nodeIds.has(target) && source !== target) {
      edges.push({ id: `e_${++edgeId}`, source, target });
    }
  }

  if (nodes.length === 0 && phases.length === 0) return null;
  return { nodes, edges, phases };
}

/** Pull a JSON object out of model text that may be fenced or have surrounding prose. */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(body);
  } catch {
    /* fall through */
  }
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(body.slice(start, end + 1));
    } catch {
      /* give up */
    }
  }
  return null;
}
