import { NextRequest, NextResponse } from "next/server";
import { requireCoachOrAdmin } from "@/lib/guard";
import { chatStream, complianceCheck, summarizeConversation, type ChatMessage } from "@/lib/ai";
import { queryRagDefault, formatRagContext, uniqueSources } from "@/lib/rag";
import { ACTIVITY_TYPES, ACTIVITY_BY_KEY } from "@/lib/activities";
import { reportComplianceFlag } from "@/lib/messages";
import {
  appendMessage,
  createConversation,
  getConversation,
  getConversationForContext,
  getMessages,
  getMessagesAfter,
  setConversationContext,
  setSummary,
} from "@/lib/ai-chat";
import type { TemplateGraph } from "@/lib/templates";

// Live-context budget (chars ≈ a safe fraction of the window). Older turns past
// this are folded into the conversation summary; the full transcript is kept.
const CONTEXT_CHAR_BUDGET = 16000;
const RECENT_KEEP = 6;

const PHASE_COLORS = ["#2563eb", "#16a34a", "#9333ea", "#ea580c", "#0891b2", "#db2777"];

// Marker separating the conversational reply (streamed live) from the proposed
// graph JSON (parsed server-side at the end).
const GRAPH_MARKER = "===GRAPH===";

function buildSystemPrompt(): string {
  const catalog = ACTIVITY_TYPES.map(
    (a) => `- ${a.key} — ${a.label} (category: ${a.category}, default gating: ${a.defaultGating})`
  ).join("\n");

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
{ "nodes": [ { "id": "n1", "activityKey": "<one of the keys below>", "gating": "OPEN"|"REVIEWED", "instructions": "<what the partner does>", "artifact": "<what the partner produces>", "phaseId": "p1"|null } ], "edges": [ { "source": "n1", "target": "n2" } ], "phases": [ { "id": "p1", "name": "<phase name>", "exitConditions": "<criteria>" } ] }
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
  artifact: string;
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

/**
 * Restore the signed-in user's saved transcript for a plan, so the assistant
 * shows prior turns when reopened. Returns the conversation id and messages.
 */
export async function GET(request: NextRequest) {
  const guard = await requireCoachOrAdmin();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  const ownerId = Number(session.user.id);
  const url = new URL(request.url);
  const tid = Number(url.searchParams.get("templateId"));
  const contextId = Number.isFinite(tid) && tid > 0 ? tid : null;

  // If the client still holds the conversation it started on this (now-saved)
  // plan, link it to the plan id so it can be restored later — even if no
  // further message was sent after saving.
  let conversation = null as Awaited<ReturnType<typeof getConversation>>;
  const cidParam = Number(url.searchParams.get("conversationId"));
  if (Number.isFinite(cidParam)) {
    const c = await getConversation(cidParam);
    if (c && c.owner_id === ownerId) {
      if (c.context_id == null && contextId != null) {
        await setConversationContext(c.id, contextId);
      }
      conversation = c;
    }
  }
  if (!conversation) {
    conversation = await getConversationForContext(ownerId, "template", contextId);
  }
  if (!conversation) return NextResponse.json({ conversationId: null, messages: [] });
  const msgs = await getMessages(conversation.id);
  return NextResponse.json({
    conversationId: conversation.id,
    messages: msgs.map((m) => ({ role: m.role, text: m.content })),
  });
}

export async function POST(request: NextRequest) {
  const guard = await requireCoachOrAdmin();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;

  const body = await request.json().catch(() => ({}));
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return NextResponse.json({ error: "Message is required" }, { status: 400 });

  const graph = body.graph ?? { nodes: [], edges: [], phases: [] };

  // Resolve (or create) the persisted conversation for this owner + plan. The
  // full transcript is stored server-side; we never trust client history.
  const ownerId = Number(session.user.id);
  const contextType = "template";
  const templateIdNum = Number(body.templateId);
  const contextId = Number.isFinite(templateIdNum) && templateIdNum > 0 ? templateIdNum : null;

  let conversation = null as Awaited<ReturnType<typeof getConversation>>;
  const convIdIn = Number(body.conversationId);
  if (Number.isFinite(convIdIn)) {
    const c = await getConversation(convIdIn);
    if (c && c.owner_id === ownerId) conversation = c;
  }
  if (!conversation) conversation = await getConversationForContext(ownerId, contextType, contextId);
  const conv = conversation ?? (await createConversation({ ownerId, contextType, contextId }));
  const conversationId = conv.id;
  // Backfill the plan link once the plan is saved (started before first save).
  if (conv.context_id == null && contextId != null) {
    await setConversationContext(conversationId, contextId);
  }

  // Prior turns (since the last summary point) — used for the compliance report
  // and as the live context for the model.
  const priorMessages = await getMessagesAfter(conversationId, conv.summarized_through);

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
        // Flush a heartbeat immediately so the connection stays alive (and the
        // proxy doesn't time out) while the compliance screen runs.
        controller.enqueue(encoder.encode(": ready\n\n"));
        // Hand the client the conversation id so it persists across turns/sessions.
        send(controller, { type: "conversation", conversationId });

        // Pre-generation compliance screen — refuse before calling the model.
        const verdict = await complianceCheck(message);
        if (!verdict.allowed) {
          // Report the flag (with the conversation so far) to admins. The flagged
          // message is captured in that report; we don't persist it into the
          // ongoing transcript so it can't re-enter the model's context.
          await reportComplianceFlag({
            userId: ownerId,
            userName: session.user.nickname || session.user.name || session.user.username || "A user",
            flaggedMessage: message,
            history: priorMessages.map((m) => ({ role: m.role, content: m.content })),
            context: "plan assistant",
          }).catch((e) => console.warn("[assistant] compliance report failed", e));
          // Keep the flagged turn in the saved transcript (admin-visible), but
          // marked flagged so it's excluded from the model's live context.
          await appendMessage(conversationId, "user", message, true);
          await appendMessage(
            conversationId,
            "assistant",
            "[This message was flagged by the compliance screen and was not sent to the model.]",
            true
          );
          send(controller, {
            type: "blocked",
            reason:
              verdict.reason || "This request was flagged by the compliance screen.",
          });
          controller.close();
          return;
        }

        // Persist the user's turn, then assemble the live context (summary +
        // recent turns), summarizing older turns if we're over budget.
        await appendMessage(conversationId, "user", message);
        let working = await getMessagesAfter(conversationId, conv.summarized_through);
        let summaryText = conv.summary;
        const totalChars =
          (summaryText?.length ?? 0) + working.reduce((a, m) => a + m.content.length, 0);
        if (totalChars > CONTEXT_CHAR_BUDGET && working.length > RECENT_KEEP) {
          const older = working.slice(0, working.length - RECENT_KEEP);
          const recent = working.slice(working.length - RECENT_KEEP);
          summaryText = await summarizeConversation({
            priorSummary: summaryText,
            olderTurns: older.map((m) => ({ role: m.role, content: m.content })),
          });
          await setSummary(conversationId, summaryText, older[older.length - 1].id);
          working = recent;
        }

        let liveSystem = system;
        if (summaryText) {
          liveSystem += `\n\nSummary of the earlier conversation (for context):\n${summaryText}`;
        }
        const messages: ChatMessage[] = working.map((m) => ({ role: m.role, content: m.content }));
        // Attach the current plan graph to the latest user turn (transient).
        const lastUser = messages[messages.length - 1];
        if (lastUser && lastUser.role === "user") {
          lastUser.content = `Current plan graph (JSON):\n${JSON.stringify(graph)}\n\nRequest: ${lastUser.content}`;
        }

        // Surface the RAG source links up front, before any model output streams.
        if (sources.length > 0) send(controller, { type: "sources", sources });

        for await (const delta of chatStream({ system: liveSystem, messages, maxTokens: 4096 })) {
          if (!firstTokenAt) firstTokenAt = Date.now();
          full += delta;
          if (graphStarted) continue;
          const mi = full.indexOf(GRAPH_MARKER);
          if (mi !== -1) {
            const prose = full.slice(0, mi);
            if (prose.length > sentLen) {
              // Drop the dangling lead-in colon from the last streamed chunk.
              const chunk = prose.slice(sentLen).replace(/[:：]\s*$/, "");
              if (chunk) send(controller, { type: "text", text: chunk });
              sentLen = prose.length;
            }
            graphStarted = true;
            // Let the client show a "constructing graph" note while the JSON streams.
            send(controller, { type: "graph_start" });
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
        let reply = (mi !== -1 ? full.slice(0, mi) : full).trim();
        // When a graph follows, the lead-in ends with a colon — drop the dangling colon.
        if (mi !== -1) reply = reply.replace(/[:：]\s*$/, "").trim();
        const proposedGraph =
          mi !== -1 ? sanitizeProposed(extractJsonObject(full.slice(mi + GRAPH_MARKER.length))) : null;

        // Persist the assistant's turn (prose, plus a note when it proposed a plan).
        const stored = (reply || "(no response)") + (proposedGraph ? "\n[Proposed a plan on the canvas.]" : "");
        await appendMessage(conversationId, "assistant", stored).catch((e) =>
          console.warn("[assistant] failed to persist reply", e)
        );

        const tEnd = Date.now();
        console.info(
          `[assistant] rag=${tRag - tStart}ms ttft=${firstTokenAt ? firstTokenAt - tRag : 0}ms model=${
            firstTokenAt ? tEnd - firstTokenAt : 0
          }ms total=${tEnd - tStart}ms`
        );

        send(controller, { type: "done", reply: reply || "(no response)", proposedGraph });
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
