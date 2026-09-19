import { chatComplete, complianceCheck, type ChatMessage } from "@/lib/ai";
import { queryRag, mergeSelectors, uniqueSources, formatRagContext } from "@/lib/rag";
import {
  getActiveActivity,
  getCopMeta,
  getThreadMessages,
  getThreadUnitScope,
} from "@/lib/messages";
import {
  appendMessage,
  createConversation,
  getConversationForContext,
  getMessages,
} from "@/lib/ai-chat";
import { getPool } from "@/lib/pg";

/** Private per-user, per-thread Dewey side-panel conversation. */
const CTX = "thread_dewey";

export type PaneTurn = { role: "user" | "assistant"; content: string; sources?: { name: string; path: string }[] };

/** Load a user's private Dewey conversation for a thread (empty if none yet). */
export async function getDeweyPane(
  threadId: number,
  userId: number
): Promise<{ conversationId: number | null; messages: PaneTurn[] }> {
  const conv = await getConversationForContext(userId, CTX, threadId);
  if (!conv) return { conversationId: null, messages: [] };
  const msgs = await getMessages(conv.id);
  return {
    conversationId: conv.id,
    messages: msgs.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
  };
}

/** Read a specific Dewey conversation's turns (for a shared "live" bubble). */
export async function getDeweyConversationTurns(conversationId: number): Promise<PaneTurn[]> {
  const msgs = await getMessages(conversationId);
  return msgs.map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
}

const SYSTEM = `You are @dewey, an AI coaching companion inside a private side chat for one person, attached to their coaching conversation. Be a warm, concise thinking partner: ask good questions, reflect, and help them reason through their work. Ground your advice in the organization's documents and the conversation's goal when relevant, and name the source. You never speak to the wider group here — this is the person's private space until they choose to share it.`;

export interface PreparedDewey {
  conversationId: number;
  system: string;
  messages: ChatMessage[];
  sources: { name: string; path: string }[];
  /** Set when the inbound message was refused by the compliance screen. */
  blocked?: string;
}

/**
 * Prepare a streamed Dewey reply: compliance-screen the message, persist the
 * user turn, and assemble the grounded system prompt + working history + sources.
 * The caller streams the reply and then calls finishDeweyPane to persist it.
 */
export async function prepareDeweyPane(params: {
  threadId: number;
  userId: number;
  message: string;
}): Promise<PreparedDewey> {
  const { threadId, userId, message } = params;
  let conv = await getConversationForContext(userId, CTX, threadId);
  if (!conv) conv = await createConversation({ ownerId: userId, contextType: CTX, contextId: threadId });

  const inbound = await complianceCheck(message);
  if (!inbound.allowed) {
    await appendMessage(conv.id, "user", message, true);
    const refusal = "I can't help with that here — try rephrasing it as a problem of practice.";
    await appendMessage(conv.id, "assistant", refusal, true);
    return { conversationId: conv.id, system: "", messages: [], sources: [], blocked: refusal };
  }
  await appendMessage(conv.id, "user", message);

  // Build grounding: the thread's goal (CoP), RAG scope, and a short transcript.
  let system = SYSTEM;
  const cop = await getCopMeta(threadId).catch(() => null);
  if (cop?.goal) {
    system += `\n\nThis conversation is a Community of Practice working toward:\n"""\n${cop.goal}\n"""`;
  }
  const units = await getThreadUnitScope(threadId).catch(() => ({
    districtId: null,
    schoolIds: [] as number[],
    copId: null,
  }));
  const active = await getActiveActivity(threadId).catch(() => null);
  const sel = mergeSelectors(active?.sources ?? null, active?.standingSources ?? null);
  const chunks = await queryRag(message, { ...units, ...sel }).catch(() => []);
  const sources = uniqueSources(chunks);
  if (chunks.length > 0) {
    system +=
      "\n\nRelevant excerpts from the organization's documents — ground your response in these and name the source:\n" +
      formatRagContext(chunks);
  }

  const history = await getThreadMessages(threadId).catch(() => []);
  const transcript = history
    .slice(-15)
    .map((m) => `${m.is_ai ? "Dewey" : m.sender_name ?? "User"}: ${m.body}`)
    .join("\n");
  if (transcript) {
    system += `\n\nFor context, the recent group conversation this person is part of:\n${transcript}`;
  }

  const paneTurns = await getMessages(conv.id);
  const messages: ChatMessage[] = paneTurns.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));
  return { conversationId: conv.id, system, messages, sources };
}

/** Persist the streamed assistant reply. */
export async function finishDeweyPane(conversationId: number, reply: string): Promise<void> {
  await appendMessage(conversationId, "assistant", reply.trim() || "(no response)");
}

/**
 * Clear a user's private Dewey conversation for a thread. Snapshots already
 * shared are frozen copies and are untouched; any "live" shared bubble that
 * pointed at this conversation goes empty (the sharing is effectively cleared).
 */
export async function clearDeweyPane(threadId: number, userId: number): Promise<void> {
  const conv = await getConversationForContext(userId, CTX, threadId);
  if (!conv) return;
  const pool = getPool();
  await pool.query("DELETE FROM ai_messages WHERE conversation_id = $1", [conv.id]);
  await pool.query("DELETE FROM ai_conversations WHERE id = $1", [conv.id]);
}

async function summarizeTurns(turns: { role: string; content: string }[]): Promise<string> {
  const transcript = turns.map((t) => `${t.role === "user" ? "Q" : "Dewey"}: ${t.content}`).join("\n").slice(0, 6000);
  try {
    const { text } = await chatComplete({
      system:
        "Summarize this private chat with the @dewey AI companion in ONE short sentence (max ~18 words) for a chat preview. Output only the sentence.",
      messages: [{ role: "user", content: transcript }],
      maxTokens: 60,
    });
    return text.trim().replace(/^["']+|["']+$/g, "").slice(0, 160) || "A conversation with @dewey";
  } catch {
    return "A conversation with @dewey";
  }
}

export type ShareMode = "snapshot" | "live";

/**
 * Share a user's private Dewey conversation into the thread as a clickable
 * bubble. 'snapshot' freezes the current turns; 'live' keeps reflecting new
 * turns. Returns the new message id.
 */
export async function shareDeweyPane(params: {
  threadId: number;
  userId: number;
  mode: ShareMode;
  summary?: string;
}): Promise<{ messageId: number; summary: string }> {
  const { threadId, userId, mode } = params;
  const conv = await getConversationForContext(userId, CTX, threadId);
  if (!conv) throw new Error("There's no Dewey conversation to share yet.");
  const turns = await getMessages(conv.id);
  if (turns.length === 0) throw new Error("There's nothing to share yet.");

  const summary = (params.summary ?? "").trim() || (await summarizeTurns(turns));
  const snapshot =
    mode === "snapshot" ? turns.map((t) => ({ role: t.role, content: t.content })) : null;

  const pool = getPool();
  const res = await pool.query(
    `INSERT INTO messages
       (thread_id, sender_id, body, dewey_conversation_id, dewey_mode, dewey_summary, dewey_snapshot)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [threadId, userId, "", conv.id, mode, summary, snapshot ? JSON.stringify(snapshot) : null]
  );
  await pool.query("UPDATE message_threads SET updated_at = NOW() WHERE id = $1", [threadId]);
  return { messageId: res.rows[0].id as number, summary };
}
