import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";
import { chatComplete, type ChatMessage } from "@/lib/ai";
import { queryRagDefault, formatRagContext } from "@/lib/rag";
import { ACTIVITY_TYPES, ACTIVITY_BY_KEY } from "@/lib/activities";
import type { TemplateGraph } from "@/lib/templates";

const PHASE_COLORS = ["#2563eb", "#16a34a", "#9333ea", "#ea580c", "#0891b2", "#db2777"];

function buildSystemPrompt(): string {
  const catalog = ACTIVITY_TYPES.map(
    (a) => `- ${a.key} — ${a.label} (category: ${a.category}, default gating: ${a.defaultGating})`
  ).join("\n");

  return `You are an assistant embedded in Dewey, an educational-leadership coaching platform, helping an admin build a reusable coaching TEMPLATE on a canvas.

Model: Arc → Phase → Activity.
- An Activity is a unit of work, drawn from a FIXED taxonomy (use only the exact keys listed below).
- A Phase bundles activities and has EXIT CONDITIONS: criteria the AI evaluates once all the phase's activities are done, surfaced to the coach before they approve advancement (distinct from an activity's done-state/gating).
- Edges indicate flow between activities (source = previous, target = next).

You can:
1. Answer questions about the current template graph.
2. Suggest activity instructions (descriptions) and phase exit conditions.
3. Create or revise an arc of phases and activities from a description.

RESPONSE FORMAT — respond with a SINGLE JSON object and nothing else:
{
  "reply": "<concise conversational answer for the admin>",
  "proposedGraph": null OR {
    "nodes": [ { "id": "n1", "activityKey": "<one of the keys below>", "gating": "OPEN" | "REVIEWED", "instructions": "<what the partner does>", "phaseId": "p1" | null } ],
    "edges": [ { "source": "n1", "target": "n2" } ],
    "phases": [ { "id": "p1", "name": "<phase name>", "exitConditions": "<criteria>" } ]
  }
}

Rules:
- Set "proposedGraph" to null unless you are proposing concrete additions/changes the admin can apply. For pure questions or advice, use null and put the content in "reply".
- Use ONLY activityKey values from the list below. Never invent new activities or keys; the activity taxonomy is fixed.
- Do NOT provide labels — each activity's label is fixed by its type.
- Give each node a unique id; reference phases by the ids you define in "phases".
- Do NOT include positions/coordinates — the canvas lays activities out automatically.
- Keep "reply" brief; the proposed graph carries the detail.

Available activity types:
${catalog}`;
}

interface ProposedNode {
  id: string;
  activityKey: string;
  label: string;
  gating: "OPEN" | "REVIEWED";
  instructions: string;
  phaseId: string | null;
  position: { x: number; y: number };
}

/** Validate + normalize a model-proposed graph: drop unknown activities, fill ids/colors, lay out. */
function sanitizeProposed(raw: unknown): TemplateGraph | null {
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
      label: def.label, // labels are fixed by activity type; ignore any model-provided label
      gating: no.gating === "OPEN" || no.gating === "REVIEWED" ? no.gating : def.defaultGating,
      instructions: typeof no.instructions === "string" ? no.instructions : "",
      phaseId,
      position: { x: 0, y: 0 },
    });
  }

  // Lay out: phases become columns (in order), unphased nodes in a trailing column.
  const colOf = new Map<string, number>();
  phases.forEach((p, i) => colOf.set(p.id, i));
  const unphasedCol = phases.length;
  const rowByCol: Record<number, number> = {};
  for (const n of nodes) {
    const col = n.phaseId != null && colOf.has(n.phaseId) ? (colOf.get(n.phaseId) as number) : unphasedCol;
    const row = rowByCol[col] ?? 0;
    rowByCol[col] = row + 1;
    n.position = { x: 60 + col * 240, y: 90 + row * 110 };
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

/** Pull a JSON object out of a model reply that may be fenced or have surrounding prose. */
function extractJsonObject(text: string): Record<string, unknown> | null {
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

export async function POST(request: NextRequest) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;

  const body = await request.json().catch(() => ({}));
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return NextResponse.json({ error: "Message is required" }, { status: 400 });

  const graph = body.graph ?? { nodes: [], edges: [], phases: [] };
  const historyIn = Array.isArray(body.history) ? body.history : [];
  const history: ChatMessage[] = historyIn
    .filter((h: unknown): h is { role: string; text: string } => !!h && typeof h === "object")
    .map((h: { role: string; text: string }) => ({
      role: h.role === "assistant" ? ("assistant" as const) : ("user" as const),
      content: String(h.text ?? ""),
    }));

  const messages: ChatMessage[] = [
    ...history,
    {
      role: "user",
      content: `Current template graph (JSON):\n${JSON.stringify(graph)}\n\nRequest: ${message}`,
    },
  ];

  // Ground the call in the org's documents via RAGDoll (default collections).
  let system = buildSystemPrompt();
  const chunks = await queryRagDefault(message).catch(() => []);
  if (chunks.length > 0) {
    system +=
      "\n\nRelevant excerpts from the organization's documents — ground your suggestions in these where applicable, and refer to document names when useful:\n" +
      formatRagContext(chunks);
  }

  try {
    const { text } = await chatComplete({ system, messages, maxTokens: 4096 });
    const parsed = extractJsonObject(text);
    if (!parsed) {
      // Model didn't return JSON — surface its text as the reply, no graph change.
      return NextResponse.json({ reply: text.trim() || "(no response)", proposedGraph: null });
    }
    const reply = typeof parsed.reply === "string" ? parsed.reply : text.trim();
    const proposedGraph = sanitizeProposed(parsed.proposedGraph);
    return NextResponse.json({ reply, proposedGraph });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Assistant request failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
