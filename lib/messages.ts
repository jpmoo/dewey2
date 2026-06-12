import { getPool } from "@/lib/pg";
import { ensureSchema, getAdminIds, logUserEvent } from "@/lib/db";

/**
 * Messaging data layer: threads, messages, and DB-stored file attachments.
 * Threads group messages between participants; admins can read every thread for
 * oversight (see listThreadsForUser / canAccessThread).
 */

export type ThreadKind =
  | "direct"
  | "template_share"
  | "template_submission"
  | "partnership"
  | "compliance";
export type ThreadStatus = "open" | "approved" | "rejected" | null;

function toIso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

export interface ThreadParticipant {
  id: number;
  full_name: string;
  system_role: string;
}

export interface AttachmentMeta {
  id: number;
  filename: string;
  mime_type: string;
  size_bytes: number;
}

export interface MessageView {
  id: number;
  sender_id: number | null;
  sender_name: string | null;
  body: string;
  created_at: string;
  attachments: AttachmentMeta[];
}

export interface ThreadSummary {
  id: number;
  kind: ThreadKind;
  subject: string | null;
  template_id: number | null;
  template_name: string | null;
  status: ThreadStatus;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  participants: ThreadParticipant[];
  last_message: { body: string; created_at: string; sender_name: string | null } | null;
  message_count: number;
}

// ============================================================
// Thread creation
// ============================================================

export async function createThread(params: {
  kind: ThreadKind;
  subject?: string | null;
  templateId?: number | null;
  status?: ThreadStatus;
  createdBy: number;
  participantIds: number[];
}): Promise<number> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    `INSERT INTO message_threads (kind, subject, template_id, status, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      params.kind,
      params.subject ?? null,
      params.templateId ?? null,
      params.status ?? null,
      params.createdBy,
    ]
  );
  const threadId = res.rows[0].id as number;
  const ids = Array.from(new Set([params.createdBy, ...params.participantIds]));
  for (const uid of ids) {
    await pool.query(
      `INSERT INTO thread_participants (thread_id, user_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [threadId, uid]
    );
  }
  return threadId;
}

/**
 * Find the existing direct thread whose participants are exactly this set of
 * users (1:1 or group), or create one. Reusing keeps a given set's conversation
 * in a single place rather than spawning duplicates.
 */
export async function findOrCreateThread(
  createdBy: number,
  recipientIds: number[]
): Promise<number> {
  const pool = getPool();
  await ensureSchema();
  const members = Array.from(new Set([createdBy, ...recipientIds])).sort((a, b) => a - b);
  const existing = await pool.query(
    `SELECT t.id
       FROM message_threads t
      WHERE t.kind = 'direct' AND t.deleted_at IS NULL
        AND (
          SELECT array_agg(p.user_id ORDER BY p.user_id)
            FROM thread_participants p WHERE p.thread_id = t.id
        ) = $1::int[]
      LIMIT 1`,
    [members]
  );
  if (existing.rows[0]) return existing.rows[0].id as number;
  return createThread({ kind: "direct", createdBy, participantIds: recipientIds });
}

export async function addParticipant(threadId: number, userId: number): Promise<void> {
  const pool = getPool();
  await ensureSchema();
  await pool.query(
    `INSERT INTO thread_participants (thread_id, user_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [threadId, userId]
  );
}

/** Archive or unarchive a thread for one user (their view only). */
export async function setThreadArchived(
  threadId: number,
  userId: number,
  archived: boolean
): Promise<void> {
  const pool = getPool();
  await ensureSchema();
  if (archived) {
    await pool.query(
      `INSERT INTO thread_archived (thread_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [threadId, userId]
    );
  } else {
    await pool.query("DELETE FROM thread_archived WHERE thread_id = $1 AND user_id = $2", [
      threadId,
      userId,
    ]);
  }
}

export async function setThreadStatus(threadId: number, status: ThreadStatus): Promise<void> {
  const pool = getPool();
  await ensureSchema();
  await pool.query("UPDATE message_threads SET status = $2, updated_at = NOW() WHERE id = $1", [
    threadId,
    status,
  ]);
}

// ============================================================
// Access
// ============================================================

/** Admins can read any thread; everyone else only threads they participate in. */
export async function canAccessThread(
  threadId: number,
  userId: number,
  isAdmin: boolean
): Promise<boolean> {
  if (isAdmin) {
    const pool = getPool();
    const res = await pool.query("SELECT 1 FROM message_threads WHERE id = $1 LIMIT 1", [threadId]);
    return res.rows.length > 0;
  }
  const pool = getPool();
  const res = await pool.query(
    "SELECT 1 FROM thread_participants WHERE thread_id = $1 AND user_id = $2 LIMIT 1",
    [threadId, userId]
  );
  return res.rows.length > 0;
}

// ============================================================
// Listing + reading
// ============================================================

/**
 * Thread summaries ordered by most recent message. Admins see all threads;
 * others see their own. Supports per-user archive filtering and a live search
 * across participant names/usernames and message contents.
 */
export async function listThreadsForUser(
  userId: number,
  isAdmin: boolean,
  opts: { q?: string; archived?: boolean } = {}
): Promise<ThreadSummary[]> {
  const pool = getPool();
  await ensureSchema();

  const params: unknown[] = [userId];
  const where: string[] = ["t.deleted_at IS NULL"];
  let join = "LEFT JOIN coaching_templates ct ON ct.id = t.template_id";
  if (!isAdmin) {
    join = "JOIN thread_participants p ON p.thread_id = t.id AND p.user_id = $1 " + join;
  }
  // Per-user archive state (admins archive their own oversight view too).
  where.push(
    opts.archived
      ? "EXISTS (SELECT 1 FROM thread_archived a WHERE a.thread_id = t.id AND a.user_id = $1)"
      : "NOT EXISTS (SELECT 1 FROM thread_archived a WHERE a.thread_id = t.id AND a.user_id = $1)"
  );
  const q = opts.q?.trim();
  if (q) {
    params.push(`%${q}%`);
    const qi = `$${params.length}`;
    where.push(`(
      t.subject ILIKE ${qi}
      OR EXISTS (SELECT 1 FROM thread_participants pp JOIN users uu ON uu.id = pp.user_id
                  WHERE pp.thread_id = t.id AND (uu.full_name ILIKE ${qi} OR uu.username ILIKE ${qi}))
      OR EXISTS (SELECT 1 FROM messages mm
                  WHERE mm.thread_id = t.id AND mm.deleted_at IS NULL AND mm.body ILIKE ${qi})
    )`);
  }

  const threadsRes = await pool.query(
    `SELECT t.*, ct.name AS template_name
       FROM message_threads t
       ${join}
      WHERE ${where.join(" AND ")}
      ORDER BY COALESCE(
        (SELECT MAX(m2.created_at) FROM messages m2
          WHERE m2.thread_id = t.id AND m2.deleted_at IS NULL),
        t.updated_at
      ) DESC`,
    params
  );

  const threads = threadsRes.rows;
  if (threads.length === 0) return [];
  const ids = threads.map((t) => t.id as number);

  const partsRes = await pool.query(
    `SELECT p.thread_id, u.id, u.full_name, u.system_role
       FROM thread_participants p
       JOIN users u ON u.id = p.user_id
      WHERE p.thread_id = ANY($1::int[])
      ORDER BY u.full_name`,
    [ids]
  );
  const byThread = new Map<number, ThreadParticipant[]>();
  for (const r of partsRes.rows) {
    const list = byThread.get(r.thread_id) ?? [];
    list.push({ id: r.id, full_name: r.full_name, system_role: r.system_role });
    byThread.set(r.thread_id, list);
  }

  // Last message + count per thread.
  const lastRes = await pool.query(
    `SELECT m.thread_id, m.body, m.created_at, u.full_name AS sender_name
       FROM messages m
       LEFT JOIN users u ON u.id = m.sender_id
       JOIN (
         SELECT thread_id, MAX(created_at) AS mx
           FROM messages WHERE deleted_at IS NULL AND thread_id = ANY($1::int[])
          GROUP BY thread_id
       ) last ON last.thread_id = m.thread_id AND last.mx = m.created_at
      WHERE m.deleted_at IS NULL`,
    [ids]
  );
  const lastByThread = new Map<number, { body: string; created_at: string; sender_name: string | null }>();
  for (const r of lastRes.rows) {
    lastByThread.set(r.thread_id, {
      body: r.body,
      created_at: toIso(r.created_at),
      sender_name: r.sender_name ?? null,
    });
  }
  const countRes = await pool.query(
    `SELECT thread_id, COUNT(*)::int AS n FROM messages
      WHERE deleted_at IS NULL AND thread_id = ANY($1::int[]) GROUP BY thread_id`,
    [ids]
  );
  const countByThread = new Map<number, number>(countRes.rows.map((r) => [r.thread_id, r.n]));

  return threads.map((t) => ({
    id: t.id,
    kind: t.kind,
    subject: t.subject ?? null,
    template_id: t.template_id ?? null,
    template_name: t.template_name ?? null,
    status: (t.status ?? null) as ThreadStatus,
    created_by: t.created_by ?? null,
    created_at: toIso(t.created_at),
    updated_at: toIso(t.updated_at),
    participants: byThread.get(t.id) ?? [],
    last_message: lastByThread.get(t.id) ?? null,
    message_count: countByThread.get(t.id) ?? 0,
  }));
}

/** A single thread's metadata (without messages). */
export async function getThreadMeta(threadId: number): Promise<ThreadSummary | null> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    `SELECT t.*, ct.name AS template_name
       FROM message_threads t
       LEFT JOIN coaching_templates ct ON ct.id = t.template_id
      WHERE t.id = $1 AND t.deleted_at IS NULL LIMIT 1`,
    [threadId]
  );
  const t = res.rows[0];
  if (!t) return null;
  const partsRes = await pool.query(
    `SELECT u.id, u.full_name, u.system_role
       FROM thread_participants p JOIN users u ON u.id = p.user_id
      WHERE p.thread_id = $1 ORDER BY u.full_name`,
    [threadId]
  );
  return {
    id: t.id,
    kind: t.kind,
    subject: t.subject ?? null,
    template_id: t.template_id ?? null,
    template_name: t.template_name ?? null,
    status: (t.status ?? null) as ThreadStatus,
    created_by: t.created_by ?? null,
    created_at: toIso(t.created_at),
    updated_at: toIso(t.updated_at),
    participants: partsRes.rows.map((r) => ({
      id: r.id,
      full_name: r.full_name,
      system_role: r.system_role,
    })),
    last_message: null,
    message_count: 0,
  };
}

export async function getThreadMessages(threadId: number): Promise<MessageView[]> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    `SELECT m.id, m.sender_id, m.body, m.created_at, u.full_name AS sender_name
       FROM messages m
       LEFT JOIN users u ON u.id = m.sender_id
      WHERE m.thread_id = $1 AND m.deleted_at IS NULL
      ORDER BY m.created_at`,
    [threadId]
  );
  const messages = res.rows;
  if (messages.length === 0) return [];

  const attRes = await pool.query(
    `SELECT id, message_id, filename, mime_type, size_bytes
       FROM message_attachments WHERE message_id = ANY($1::bigint[]) ORDER BY id`,
    [messages.map((m) => m.id)]
  );
  const byMessage = new Map<number, AttachmentMeta[]>();
  for (const r of attRes.rows) {
    const list = byMessage.get(Number(r.message_id)) ?? [];
    list.push({
      id: Number(r.id),
      filename: r.filename,
      mime_type: r.mime_type,
      size_bytes: r.size_bytes,
    });
    byMessage.set(Number(r.message_id), list);
  }

  return messages.map((m) => ({
    id: Number(m.id),
    sender_id: (m.sender_id as number | null) ?? null,
    sender_name: (m.sender_name as string | null) ?? null,
    body: m.body as string,
    created_at: toIso(m.created_at),
    attachments: byMessage.get(Number(m.id)) ?? [],
  }));
}

// ============================================================
// Posting
// ============================================================

export async function postMessage(params: {
  threadId: number;
  senderId: number;
  body: string;
}): Promise<number> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    `INSERT INTO messages (thread_id, sender_id, body) VALUES ($1, $2, $3) RETURNING id`,
    [params.threadId, params.senderId, params.body]
  );
  await pool.query("UPDATE message_threads SET updated_at = NOW() WHERE id = $1", [params.threadId]);
  return Number(res.rows[0].id);
}

export async function addAttachment(params: {
  messageId: number;
  filename: string;
  mimeType: string;
  data: Buffer;
}): Promise<number> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    `INSERT INTO message_attachments (message_id, filename, mime_type, size_bytes, data)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [params.messageId, params.filename, params.mimeType, params.data.length, params.data]
  );
  return Number(res.rows[0].id);
}

/** Fetch attachment bytes plus the thread it belongs to (for an access check). */
export async function getAttachmentForDownload(
  attachmentId: number
): Promise<{ filename: string; mimeType: string; data: Buffer; threadId: number } | null> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    `SELECT a.filename, a.mime_type, a.data, m.thread_id
       FROM message_attachments a
       JOIN messages m ON m.id = a.message_id
      WHERE a.id = $1 LIMIT 1`,
    [attachmentId]
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    filename: r.filename,
    mimeType: r.mime_type,
    data: r.data as Buffer,
    threadId: r.thread_id as number,
  };
}

// ============================================================
// Compliance flags
// ============================================================

/**
 * Record a compliance-screen flag: log it on the flagged user's card and post a
 * detailed report (the flagged message plus the conversation so far) to a
 * per-user compliance thread visible only to admins. The flagged user is NOT a
 * participant, so the internal report never surfaces to them.
 */
export async function reportComplianceFlag(params: {
  userId: number;
  userName: string;
  flaggedMessage: string;
  history: { role: string; content: string }[];
  context?: string;
}): Promise<void> {
  const pool = getPool();
  await ensureSchema();

  // Reuse the user's existing compliance thread, else create one (admins only).
  const existing = await pool.query(
    `SELECT id FROM message_threads
      WHERE kind = 'compliance' AND created_by = $1 AND deleted_at IS NULL
      ORDER BY id LIMIT 1`,
    [params.userId]
  );
  let threadId: number;
  if (existing.rows[0]) {
    threadId = existing.rows[0].id as number;
  } else {
    const created = await pool.query(
      `INSERT INTO message_threads (kind, subject, created_by)
       VALUES ('compliance', $1, $2) RETURNING id`,
      [`Compliance flags — ${params.userName}`, params.userId]
    );
    threadId = created.rows[0].id as number;
    for (const adminId of await getAdminIds()) {
      await pool.query(
        `INSERT INTO thread_participants (thread_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [threadId, adminId]
      );
    }
  }

  const transcript = params.history
    .map((h) => `${h.role === "assistant" ? "Assistant" : "User"}: ${h.content}`)
    .join("\n");
  const body = [
    `⚠ The compliance screen flagged a message${params.context ? ` (${params.context})` : ""}.`,
    "",
    "Flagged message:",
    params.flaggedMessage,
    ...(transcript ? ["", "Conversation so far:", transcript] : []),
  ].join("\n");

  await postMessage({ threadId, senderId: params.userId, body });
  await logUserEvent({
    userId: params.userId,
    actorId: params.userId,
    action: "compliance_flagged",
    detail: params.context ?? null,
  });
}

// ============================================================
// Template submissions (admin panel)
// ============================================================

export interface SubmissionView {
  thread_id: number;
  template_id: number | null;
  template_name: string | null;
  coach_id: number | null;
  coach_name: string | null;
  message: string | null;
  created_at: string;
}

/** Open (undecided) template submissions, newest first. */
export async function listOpenSubmissions(): Promise<SubmissionView[]> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    `SELECT t.id AS thread_id, t.template_id, t.created_by AS coach_id, t.created_at,
            ct.name AS template_name, u.full_name AS coach_name,
            (SELECT body FROM messages m
              WHERE m.thread_id = t.id AND m.deleted_at IS NULL
              ORDER BY m.created_at LIMIT 1) AS message
       FROM message_threads t
       LEFT JOIN coaching_templates ct ON ct.id = t.template_id
       LEFT JOIN users u ON u.id = t.created_by
      WHERE t.kind = 'template_submission' AND t.status = 'open' AND t.deleted_at IS NULL
      ORDER BY t.created_at DESC`
  );
  return res.rows.map((r) => ({
    thread_id: r.thread_id,
    template_id: r.template_id ?? null,
    template_name: r.template_name ?? null,
    coach_id: r.coach_id ?? null,
    coach_name: r.coach_name ?? null,
    message: r.message ?? null,
    created_at: toIso(r.created_at),
  }));
}
