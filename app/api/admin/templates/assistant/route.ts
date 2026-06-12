import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";
import { chatStream, type ChatMessage } from "@/lib/ai";
import { queryRagDefault, formatRagContext, uniqueSources } from "@/lib/rag";
import { ACTIVITY_TYPES, ACTIVITY_BY_KEY } from "@/lib/activities";
import type { TemplateGraph } from "@/lib/templates";

const PHASE_COLORS = ["#2563eb", "#16a34a", "#9333ea", "#ea580c", "#0891b2", "#db2777"];

// Marker separating the conversational reply (streamed live) from the proposed
// graph JSON (parsed server-side at the end).
const GRAPH_MARKER = "===GRAPH===";

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

RESPONSE FORMAT:
- First write a brief conversational reply to the admin, in plain prose.
- If (and ONLY if) you are proposing concrete additions/changes to the canvas, then output a line containing exactly:
${GRAPH_MARKER}
followed by a single JSON object:
{ "nodes": [ { "id": "n1", "activityKey": "<one of the keys below>", "gating": "OPEN"|"REVIEWED", "instructions": "<what the partner does>", "phaseId": "p1"|null } ], "edges": [ { "source": "n1", "target": "n2" } ], "phases": [ { "id": "p1", "name": "<phase name>", "exitConditions": "<criteria>" } ] }
- For questions or advice with no canvas change, do NOT output the marker or any JSON.

Rules:
- Use ONLY activityKey values from the list below. Never invent new activities or keys; the activity taxonomy is fixed.
- Do NOT provide labels — each activity's label is fixed by its type.
- Give each node a unique id; reference phases by the ids you define in "phases".
- Do NOT include positions/coordinates — the canvas lays activities out automatically.

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
      label: def.label, // labels are fixed by activity type
      gating: no.gating === "OPEN" || no.gating === "REVIEWED" ? no.gating : def.defaultGating,
      instructions:
        typeof no.instructions === "string" && no.instructions
          ? no.instructions
          : def.defaultInstructions,
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

  // Ground the call in the org's documents via RAGDoll (default collections).
  const tStart = Date.now();
  let system = buildSystemPrompt();
  const chunks = await queryRagDefault(message).catch(() => []);
  const tRag = Date.now();
  const sources = uniqueSources(chunks);
  if (chunks.length > 0) {
    system +=
      "\n\nRelevant excerpts from the organization's documents — ground your suggestions in these where applicable, and refer to document names when useful:\n" +
      formatRagContext(chunks);
  }

  const messages: ChatMessage[] = [
    ...history,
    {
      role: "user",
      content: `Current template graph (JSON):\n${JSON.stringify(graph)}\n\nRequest: ${message}`,
    },
  ];

  const encoder = new TextEncoder();
  const send = (controller: ReadableStreamDefaultController, obj: unknown) =>
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

  const stream = new ReadableStream({
    async start(controller) {
      let full = "";
      let sentLen = 0; // prose chars already streamed
      let graphStarted = false;
      let firstTokenAt = 0;
      try {
        for await (const delta of chatStream({ system, messages, maxTokens: 4096 })) {
          if (!firstTokenAt) firstTokenAt = Date.now();
          full += delta;
          if (graphStarted) continue;
          const mi = full.indexOf(GRAPH_MARKER);
          if (mi !== -1) {
            const prose = full.slice(0, mi);
            if (prose.length > sentLen) {
              send(controller, { type: "text", text: prose.slice(sentLen) });
              sentLen = prose.length;
            }
            graphStarted = true;
          } else {
            // Hold back a marker-length tail so we never stream a partial marker.
            const safe = Math.max(sentLen, full.length - (GRAPH_MARKER.length - 1));
            if (safe > sentLen) {
              send(controller, { type: "text", text: full.slice(sentLen, safe) });
              sentLen = safe;
            }
          }
        }

        const mi = full.indexOf(GRAPH_MARKER);
        if (mi === -1 && full.length > sentLen) {
          send(controller, { type: "text", text: full.slice(sentLen) });
        }
        const reply = (mi !== -1 ? full.slice(0, mi) : full).trim();
        const proposedGraph =
          mi !== -1 ? sanitizeProposed(extractJsonObject(full.slice(mi + GRAPH_MARKER.length))) : null;

        const tEnd = Date.now();
        console.info(
          `[assistant] rag=${tRag - tStart}ms ttft=${firstTokenAt ? firstTokenAt - tRag : 0}ms model=${
            firstTokenAt ? tEnd - firstTokenAt : 0
          }ms total=${tEnd - tStart}ms`
        );

        send(controller, { type: "done", reply: reply || "(no response)", proposedGraph, sources });
      } catch (e) {
        send(controller, {
          type: "error",
          error: e instanceof Error ? e.message : "Assistant request failed",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
