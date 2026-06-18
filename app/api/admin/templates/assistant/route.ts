import { NextRequest, NextResponse } from "next/server";
import { requireCoachOrAdmin } from "@/lib/guard";
import { chatStream, complianceCheck, summarizeConversation, type ChatMessage } from "@/lib/ai";
import { queryRagDefault, formatRagContext, uniqueSources } from "@/lib/rag";
import { reportComplianceFlag } from "@/lib/messages";
import { allowAiRequest } from "@/lib/rate-limit";
import {
  buildCanvasPlanPrompt,
  sanitizeProposedGraph,
  extractJsonObject,
  GRAPH_MARKER,
} from "@/lib/plan-ai";
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

// Live-context budget (chars ≈ a safe fraction of the window). Older turns past
// this are folded into the conversation summary; the full transcript is kept.
const CONTEXT_CHAR_BUDGET = 16000;
const RECENT_KEEP = 6;

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

  if (!allowAiRequest(Number(session.user.id))) {
    return NextResponse.json(
      { error: "You're sending requests too quickly — please wait a moment." },
      { status: 429 }
    );
  }

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
  let system = buildCanvasPlanPrompt();
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
              // Normalize a dangling lead-in colon to an ellipsis (we ask the
              // model not to use a colon, but be safe).
              const chunk = prose.slice(sentLen).replace(/[:：]\s*$/, "…");
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
        // When a graph follows, normalize a trailing colon to an ellipsis.
        if (mi !== -1) reply = reply.replace(/[:：]\s*$/, "…").trim();
        const proposedGraph =
          mi !== -1 ? sanitizeProposedGraph(extractJsonObject(full.slice(mi + GRAPH_MARKER.length))) : null;

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
