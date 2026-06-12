import { getPool } from "@/lib/pg";
import { ensureSchema } from "@/lib/db";

/**
 * Persistence for AI chat transcripts. Every turn is saved server-side (one
 * write per turn, not per keystroke). The full transcript is never deleted;
 * older turns are folded into a rolling `summary` only to fit the model's
 * context window. Reads are owner-or-admin only.
 */

export type AiRole = "user" | "assistant";

export interface AiMessage {
  id: number;
  role: AiRole;
  content: string;
  created_at: string;
}

export interface AiConversation {
  id: number;
  owner_id: number | null;
  context_type: string;
  context_id: number | null;
  summary: string | null;
  summarized_through: number;
  created_at: string;
  updated_at: string;
}

function toIso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

function rowToConversation(r: Record<string, unknown>): AiConversation {
  return {
    id: r.id as number,
    owner_id: (r.owner_id as number | null) ?? null,
    context_type: r.context_type as string,
    context_id: (r.context_id as number | null) ?? null,
    summary: (r.summary as string | null) ?? null,
    summarized_through: Number(r.summarized_through ?? 0),
    created_at: toIso(r.created_at),
    updated_at: toIso(r.updated_at),
  };
}

export async function getConversation(id: number): Promise<AiConversation | null> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query("SELECT * FROM ai_conversations WHERE id = $1 LIMIT 1", [id]);
  return res.rows[0] ? rowToConversation(res.rows[0]) : null;
}

/** The owner's conversation for a given context, if one exists. */
export async function getConversationForContext(
  ownerId: number,
  contextType: string,
  contextId: number | null
): Promise<AiConversation | null> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    `SELECT * FROM ai_conversations
      WHERE owner_id = $1 AND context_type = $2
        AND context_id IS NOT DISTINCT FROM $3
      ORDER BY updated_at DESC LIMIT 1`,
    [ownerId, contextType, contextId]
  );
  return res.rows[0] ? rowToConversation(res.rows[0]) : null;
}

export async function createConversation(params: {
  ownerId: number;
  contextType: string;
  contextId: number | null;
}): Promise<AiConversation> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    `INSERT INTO ai_conversations (owner_id, context_type, context_id)
     VALUES ($1, $2, $3) RETURNING *`,
    [params.ownerId, params.contextType, params.contextId]
  );
  return rowToConversation(res.rows[0]);
}

export async function appendMessage(
  conversationId: number,
  role: AiRole,
  content: string
): Promise<number> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    `INSERT INTO ai_messages (conversation_id, role, content) VALUES ($1, $2, $3) RETURNING id`,
    [conversationId, role, content]
  );
  await pool.query("UPDATE ai_conversations SET updated_at = NOW() WHERE id = $1", [conversationId]);
  return Number(res.rows[0].id);
}

export async function getMessages(conversationId: number): Promise<AiMessage[]> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    "SELECT id, role, content, created_at FROM ai_messages WHERE conversation_id = $1 ORDER BY id",
    [conversationId]
  );
  return res.rows.map((r) => ({
    id: Number(r.id),
    role: r.role as AiRole,
    content: r.content as string,
    created_at: toIso(r.created_at),
  }));
}

/** Messages not yet folded into the summary (id > summarized_through). */
export async function getMessagesAfter(
  conversationId: number,
  afterId: number
): Promise<AiMessage[]> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    `SELECT id, role, content, created_at FROM ai_messages
      WHERE conversation_id = $1 AND id > $2 ORDER BY id`,
    [conversationId, afterId]
  );
  return res.rows.map((r) => ({
    id: Number(r.id),
    role: r.role as AiRole,
    content: r.content as string,
    created_at: toIso(r.created_at),
  }));
}

/** Link a conversation to a context id once it's known (e.g. after first save). */
export async function setConversationContext(
  conversationId: number,
  contextId: number
): Promise<void> {
  const pool = getPool();
  await ensureSchema();
  await pool.query(
    "UPDATE ai_conversations SET context_id = $2 WHERE id = $1 AND context_id IS NULL",
    [conversationId, contextId]
  );
}

export async function setSummary(
  conversationId: number,
  summary: string,
  summarizedThrough: number
): Promise<void> {
  const pool = getPool();
  await ensureSchema();
  await pool.query(
    "UPDATE ai_conversations SET summary = $2, summarized_through = $3, updated_at = NOW() WHERE id = $1",
    [conversationId, summary, summarizedThrough]
  );
}

// ============================================================
// Admin: list a user's conversations (for the audit log view)
// ============================================================

export interface ConversationSummaryRow {
  id: number;
  context_type: string;
  context_id: number | null;
  context_name: string | null;
  message_count: number;
  created_at: string;
  updated_at: string;
  preview: string | null;
}

export async function listConversationsForOwner(
  ownerId: number
): Promise<ConversationSummaryRow[]> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    `SELECT c.id, c.context_type, c.context_id, c.created_at, c.updated_at,
            ct.name AS context_name,
            (SELECT COUNT(*)::int FROM ai_messages m WHERE m.conversation_id = c.id) AS message_count,
            (SELECT content FROM ai_messages m WHERE m.conversation_id = c.id ORDER BY id LIMIT 1) AS preview
       FROM ai_conversations c
       LEFT JOIN coaching_templates ct
         ON c.context_type = 'template' AND ct.id = c.context_id
      WHERE c.owner_id = $1
      ORDER BY c.updated_at DESC`,
    [ownerId]
  );
  return res.rows.map((r) => ({
    id: r.id as number,
    context_type: r.context_type as string,
    context_id: (r.context_id as number | null) ?? null,
    context_name: (r.context_name as string | null) ?? null,
    message_count: Number(r.message_count ?? 0),
    created_at: toIso(r.created_at),
    updated_at: toIso(r.updated_at),
    preview: (r.preview as string | null) ?? null,
  }));
}
