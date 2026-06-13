import { getPool } from "@/lib/pg";
import {
  deactivatePriorThreadPlans,
  duplicatePlanForPartnership,
  ensureSchema,
  getAdminIds,
  getMessageRecipients,
  logUserEvent,
  threadHasAcceptedPlan,
} from "@/lib/db";
import { getSystemSettings } from "@/lib/settings";
import { summarizeWithComplianceModel } from "@/lib/ai";

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
export type ThreadStatus = "open" | "approved" | "rejected" | "done" | "abandoned" | null;

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
  /** Set when this message embeds a partnership plan copy. */
  plan_id: number | null;
  plan_name: string | null;
  plan_phase: string | null;
  /** Whether the coach has accepted the embedded plan (partnership plans only). */
  plan_accepted: boolean;
  /** Whether a newer plan has superseded this embedded plan (partnership plans only). */
  plan_deactivated: boolean;
  is_ai: boolean;
  reply_to: number | null;
  reply_excerpt: string | null;
  reply_sender: string | null;
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
  unread: boolean;
  /** The thread's accepted partnership plan (id + name), if any — for the list "View plan" pill. */
  accepted_plan_id: number | null;
  accepted_plan_name: string | null;
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

/** Rename a thread (set its subject). */
export async function setThreadSubject(threadId: number, subject: string): Promise<void> {
  const pool = getPool();
  await ensureSchema();
  await pool.query("UPDATE message_threads SET subject = $2, updated_at = NOW() WHERE id = $1", [
    threadId,
    subject,
  ]);
}

// ============================================================
// Access
// ============================================================

/**
 * Admins can read any thread; everyone else only threads they participate in.
 * For partnership threads, an invited member must have accepted (the creating
 * coach always has access) — a pending/declined invitation can't read the thread.
 */
export async function canAccessThread(
  threadId: number,
  userId: number,
  isAdmin: boolean
): Promise<boolean> {
  const pool = getPool();
  if (isAdmin) {
    const res = await pool.query("SELECT 1 FROM message_threads WHERE id = $1 LIMIT 1", [threadId]);
    return res.rows.length > 0;
  }
  const res = await pool.query(
    `SELECT t.kind, t.created_by, p.accepted
       FROM message_threads t
       JOIN thread_participants p ON p.thread_id = t.id AND p.user_id = $2
      WHERE t.id = $1 AND t.deleted_at IS NULL LIMIT 1`,
    [threadId, userId]
  );
  const r = res.rows[0];
  if (!r) return false;
  if (r.kind === "partnership" && r.accepted !== true && r.created_by !== userId) return false;
  return true;
}

// ============================================================
// Adding participants (@-mention) + partnership invitations
// ============================================================

/** Participant ids whose messaging rights count toward "who can add someone". */
async function activeParticipantIds(threadId: number): Promise<number[]> {
  const pool = getPool();
  const res = await pool.query(
    `SELECT p.user_id
       FROM thread_participants p
       JOIN message_threads t ON t.id = p.thread_id
      WHERE p.thread_id = $1
        AND (t.kind <> 'partnership' OR p.accepted = TRUE OR t.created_by = p.user_id)`,
    [threadId]
  );
  return res.rows.map((r) => r.user_id as number);
}

export interface AddableUser {
  id: number;
  full_name: string;
  username: string;
  system_role: string;
}

/**
 * Users the requester may add to a thread by @username: the union of everyone
 * the thread's active members may message (only one member needs the right),
 * minus current participants. For partnership threads, only the coach may add.
 */
export async function getThreadAddableUsers(
  threadId: number,
  requesterId: number,
  q: string
): Promise<AddableUser[]> {
  const pool = getPool();
  await ensureSchema();
  const meta = await pool.query(
    "SELECT kind, created_by FROM message_threads WHERE id = $1 AND deleted_at IS NULL",
    [threadId]
  );
  const t = meta.rows[0];
  if (!t) return [];
  const part = await pool.query(
    "SELECT 1 FROM thread_participants WHERE thread_id = $1 AND user_id = $2",
    [threadId, requesterId]
  );
  if (!part.rows[0]) return [];
  if (t.kind === "partnership" && t.created_by !== requesterId) return [];

  const settings = await getSystemSettings();
  const memberIds = await activeParticipantIds(threadId);
  const current = new Set(
    (
      await pool.query("SELECT user_id FROM thread_participants WHERE thread_id = $1", [threadId])
    ).rows.map((r) => r.user_id as number)
  );

  const union = new Map<number, AddableUser>();
  for (const mid of memberIds) {
    const recs = await getMessageRecipients(mid, settings.message_permissions);
    for (const r of recs) {
      if (current.has(r.id)) continue;
      union.set(r.id, {
        id: r.id,
        full_name: r.full_name,
        username: r.username,
        system_role: r.system_role,
      });
    }
  }
  const needle = q.trim().toLowerCase();
  let list = Array.from(union.values());
  if (needle) list = list.filter((u) => `${u.full_name} ${u.username}`.toLowerCase().includes(needle));
  return list.sort((a, b) => a.full_name.localeCompare(b.full_name)).slice(0, 8);
}

/** Add a user to a thread under the union rule. Returns whether it created a
 *  pending invitation (partnership threads) vs. a full participant. */
export async function addUserToThread(
  threadId: number,
  requesterId: number,
  targetId: number
): Promise<{ ok: boolean; pending: boolean; error?: string }> {
  const pool = getPool();
  await ensureSchema();
  const meta = await pool.query(
    "SELECT kind, created_by FROM message_threads WHERE id = $1 AND deleted_at IS NULL",
    [threadId]
  );
  const t = meta.rows[0];
  if (!t) return { ok: false, pending: false, error: "Not found" };
  const part = await pool.query(
    "SELECT 1 FROM thread_participants WHERE thread_id = $1 AND user_id = $2",
    [threadId, requesterId]
  );
  if (!part.rows[0]) return { ok: false, pending: false, error: "Not a participant" };
  if (t.kind === "partnership" && t.created_by !== requesterId)
    return { ok: false, pending: false, error: "Only the coach can add to a partnership" };

  const already = await pool.query(
    "SELECT 1 FROM thread_participants WHERE thread_id = $1 AND user_id = $2",
    [threadId, targetId]
  );
  if (already.rows[0]) return { ok: true, pending: false };

  const settings = await getSystemSettings();
  const memberIds = await activeParticipantIds(threadId);
  let allowed = false;
  for (const mid of memberIds) {
    const recs = await getMessageRecipients(mid, settings.message_permissions);
    if (recs.some((r) => r.id === targetId)) {
      allowed = true;
      break;
    }
  }
  if (!allowed) return { ok: false, pending: false, error: "No one here can message that user" };

  // accepted defaults NULL → a pending invitation for partnership threads.
  await pool.query(
    "INSERT INTO thread_participants (thread_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [threadId, targetId]
  );
  await pool.query("UPDATE message_threads SET updated_at = NOW() WHERE id = $1", [threadId]);
  return { ok: true, pending: t.kind === "partnership" };
}

export interface InvitationView {
  thread_id: number;
  coach_name: string | null;
  member_names: string[];
  created_at: string;
}

/** Pending partnership invitations for a user (accepted IS NULL). */
export async function getPendingInvitations(userId: number): Promise<InvitationView[]> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    `SELECT t.id AS thread_id, t.created_at, u.full_name AS coach_name
       FROM message_threads t
       JOIN thread_participants p ON p.thread_id = t.id AND p.user_id = $1 AND p.accepted IS NULL
       LEFT JOIN users u ON u.id = t.created_by
      WHERE t.kind = 'partnership' AND t.deleted_at IS NULL
      ORDER BY t.created_at DESC`,
    [userId]
  );
  const out: InvitationView[] = [];
  for (const r of res.rows) {
    const members = await pool.query(
      `SELECT u.full_name FROM thread_participants p JOIN users u ON u.id = p.user_id
        WHERE p.thread_id = $1 ORDER BY u.full_name`,
      [r.thread_id]
    );
    out.push({
      thread_id: r.thread_id as number,
      coach_name: (r.coach_name as string | null) ?? null,
      member_names: members.rows.map((m) => m.full_name as string),
      created_at: toIso(r.created_at),
    });
  }
  return out;
}

/** Accept or decline a partnership invitation. */
export async function respondToInvitation(
  threadId: number,
  userId: number,
  accept: boolean
): Promise<boolean> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    `UPDATE thread_participants p SET accepted = $3
       FROM message_threads t
      WHERE p.thread_id = $1 AND p.user_id = $2 AND p.thread_id = t.id
        AND t.kind = 'partnership' AND p.accepted IS NULL`,
    [threadId, userId, accept]
  );
  return (res.rowCount ?? 0) > 0;
}

export interface PartnershipMember {
  id: number;
  full_name: string;
  accepted: boolean | null;
}
export interface PartnershipCard {
  thread_id: number;
  created_at: string;
  subject: string;
  status: ThreadStatus;
  members: PartnershipMember[];
}

/** Partnerships a user can see: ones they created (coach) or accepted (partner). */
export async function getPartnershipsForUser(userId: number): Promise<PartnershipCard[]> {
  const pool = getPool();
  await ensureSchema();
  const threads = await pool.query(
    `SELECT DISTINCT t.id, t.created_at, t.subject, t.status
       FROM message_threads t
       JOIN thread_participants p ON p.thread_id = t.id AND p.user_id = $1
      WHERE t.kind = 'partnership' AND t.deleted_at IS NULL
        AND (t.created_by = $1 OR p.accepted = TRUE)
      ORDER BY t.created_at DESC`,
    [userId]
  );
  const out: PartnershipCard[] = [];
  for (const t of threads.rows) {
    const members = await pool.query(
      `SELECT u.id, u.full_name, p.accepted
         FROM thread_participants p JOIN users u ON u.id = p.user_id
        WHERE p.thread_id = $1 ORDER BY u.full_name`,
      [t.id]
    );
    out.push({
      thread_id: t.id as number,
      created_at: toIso(t.created_at),
      subject: (t.subject as string) || "Partnership",
      status: (t.status ?? null) as ThreadStatus,
      members: members.rows.map((m) => ({
        id: m.id as number,
        full_name: m.full_name as string,
        accepted: (m.accepted as boolean | null) ?? null,
      })),
    });
  }
  return out;
}

/**
 * Derive a short partnership name from its description using the summarization
 * model. Falls back to "Partnership" if no model is configured or it fails.
 */
async function namePartnership(description: string): Promise<string> {
  const text = description.trim();
  if (!text) return "Partnership";
  try {
    const raw = await summarizeWithComplianceModel(
      `Give a short, specific title (3-6 words, no quotes, no trailing punctuation) for a coaching partnership described as:\n\n${text}`
    );
    const name = raw.split("\n")[0].replace(/^["']|["']$/g, "").replace(/[.]+$/, "").trim();
    if (name) return name.length > 80 ? name.slice(0, 80).trim() : name;
  } catch {
    // fall through to default
  }
  return "Partnership";
}

/** Create a partnership thread: coach is auto-accepted, partners are invited. */
export async function createPartnership(
  coachId: number,
  partnerIds: number[],
  message: string
): Promise<number> {
  const pool = getPool();
  await ensureSchema();
  const subject = await namePartnership(message);
  const threadId = await createThread({
    kind: "partnership",
    subject,
    createdBy: coachId,
    participantIds: partnerIds,
  });
  await pool.query(
    "UPDATE thread_participants SET accepted = TRUE WHERE thread_id = $1 AND user_id = $2",
    [threadId, coachId]
  );
  await postMessage({ threadId, senderId: coachId, body: message });
  return threadId;
}

/** Audit-log a message-center action with a deep-link to the thread. */
export async function logThreadEvent(params: {
  userId: number;
  actorId: number;
  action: string;
  threadId: number;
  detail?: string | null;
}): Promise<void> {
  const meta = await getThreadMeta(params.threadId);
  await logUserEvent({
    userId: params.userId,
    actorId: params.actorId,
    action: params.action,
    detail: params.detail ?? null,
    entityType: "message",
    entityId: params.threadId,
    entityLabel: meta?.subject || "Conversation",
  });
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
    // Hide partnership threads the user hasn't accepted (they appear as
    // invitations instead); the creating coach always sees their own.
    where.push("(t.kind <> 'partnership' OR p.accepted = TRUE OR t.created_by = $1)");
  }
  // Per-user archive state (admins archive their own oversight view too). A
  // partnership that has been marked done or abandoned counts as archived for
  // everyone, so it leaves the active list and joins the archived area.
  // NULL-safe: an open partnership has status NULL, and NULL IN (...) is NULL
  // (not FALSE), so COALESCE it to a sentinel before comparing.
  const isArchived =
    "(EXISTS (SELECT 1 FROM thread_archived a WHERE a.thread_id = t.id AND a.user_id = $1)" +
    " OR (t.kind = 'partnership' AND COALESCE(t.status, 'open') IN ('done', 'abandoned')))";
  where.push(opts.archived ? isArchived : `NOT ${isArchived}`);
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
    `SELECT t.*, ct.name AS template_name,
            ap.id AS accepted_plan_id, ap.name AS accepted_plan_name,
            (
              EXISTS (SELECT 1 FROM thread_participants tp WHERE tp.thread_id = t.id AND tp.user_id = $1)
              AND EXISTS (
                SELECT 1 FROM messages m
                 WHERE m.thread_id = t.id AND m.deleted_at IS NULL AND m.sender_id <> $1
                   AND m.created_at > COALESCE(
                     (SELECT last_read_at FROM thread_participants tpr
                       WHERE tpr.thread_id = t.id AND tpr.user_id = $1),
                     '1970-01-01'::timestamptz)
              )
            ) AS unread
       FROM message_threads t
       LEFT JOIN LATERAL (
         SELECT cp.id, cp.name FROM coaching_templates cp
          WHERE cp.thread_id = t.id AND cp.scope = 'partnership'
            AND cp.deleted_at IS NULL AND cp.accepted_at IS NOT NULL
          ORDER BY cp.accepted_at DESC LIMIT 1
       ) ap ON TRUE
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
    `SELECT m.thread_id, m.body, m.created_at,
            CASE WHEN m.is_ai THEN '@dewey'
                 ELSE COALESCE(NULLIF(u.nickname, ''), u.full_name) END AS sender_name
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
    unread: t.unread === true,
    accepted_plan_id: (t.accepted_plan_id as number | null) ?? null,
    accepted_plan_name: (t.accepted_plan_name as string | null) ?? null,
  }));
}

/** Mark a thread read for a user (their participant row). */
export async function markThreadRead(threadId: number, userId: number): Promise<void> {
  const pool = getPool();
  await ensureSchema();
  await pool.query(
    "UPDATE thread_participants SET last_read_at = NOW() WHERE thread_id = $1 AND user_id = $2",
    [threadId, userId]
  );
}

/** Count of the user's threads with unread messages (excludes archived/pending). */
export async function getUnreadThreadCount(userId: number): Promise<number> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    `SELECT COUNT(*)::int AS n
       FROM message_threads t
       JOIN thread_participants p ON p.thread_id = t.id AND p.user_id = $1
      WHERE t.deleted_at IS NULL
        AND (t.kind <> 'partnership' OR p.accepted = TRUE OR t.created_by = $1)
        AND NOT (t.kind = 'partnership' AND COALESCE(t.status, 'open') IN ('done', 'abandoned'))
        AND NOT EXISTS (SELECT 1 FROM thread_archived a WHERE a.thread_id = t.id AND a.user_id = $1)
        AND EXISTS (
          SELECT 1 FROM messages m
           WHERE m.thread_id = t.id AND m.deleted_at IS NULL AND m.sender_id <> $1
             AND m.created_at > COALESCE(p.last_read_at, '1970-01-01'::timestamptz)
        )`,
    [userId]
  );
  return res.rows[0]?.n ?? 0;
}

/** A single thread's metadata (without messages). */
export async function getThreadMeta(threadId: number): Promise<ThreadSummary | null> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    `SELECT t.*, ct.name AS template_name,
            ap.id AS accepted_plan_id, ap.name AS accepted_plan_name
       FROM message_threads t
       LEFT JOIN coaching_templates ct ON ct.id = t.template_id
       LEFT JOIN LATERAL (
         SELECT cp.id, cp.name FROM coaching_templates cp
          WHERE cp.thread_id = t.id AND cp.scope = 'partnership'
            AND cp.deleted_at IS NULL AND cp.accepted_at IS NOT NULL
          ORDER BY cp.accepted_at DESC LIMIT 1
       ) ap ON TRUE
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
    unread: false,
    accepted_plan_id: (t.accepted_plan_id as number | null) ?? null,
    accepted_plan_name: (t.accepted_plan_name as string | null) ?? null,
  };
}

export async function getThreadMessages(threadId: number): Promise<MessageView[]> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    `SELECT m.id, m.sender_id, m.body, m.created_at, u.full_name AS sender_name, m.is_ai,
            m.plan_id, ct.name AS plan_name,
            ct.graph -> 'phases' -> 0 ->> 'name' AS plan_phase,
            (ct.accepted_at IS NOT NULL) AS plan_accepted,
            (ct.deactivated_at IS NOT NULL) AS plan_deactivated,
            m.reply_to,
            LEFT(rm.body, 120) AS reply_excerpt,
            CASE WHEN rm.id IS NULL THEN NULL
                 WHEN rm.is_ai THEN '@dewey'
                 ELSE COALESCE(NULLIF(ru.nickname, ''), ru.full_name) END AS reply_sender
       FROM messages m
       LEFT JOIN users u ON u.id = m.sender_id
       LEFT JOIN coaching_templates ct ON ct.id = m.plan_id
       LEFT JOIN messages rm ON rm.id = m.reply_to
       LEFT JOIN users ru ON ru.id = rm.sender_id
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
    plan_id: (m.plan_id as number | null) ?? null,
    plan_name: (m.plan_name as string | null) ?? null,
    plan_phase: (m.plan_phase as string | null) ?? null,
    plan_accepted: m.plan_accepted === true,
    plan_deactivated: m.plan_deactivated === true,
    is_ai: m.is_ai === true,
    reply_to: m.reply_to != null ? Number(m.reply_to) : null,
    reply_excerpt: (m.reply_excerpt as string | null) ?? null,
    reply_sender: (m.reply_sender as string | null) ?? null,
  }));
}

// ============================================================
// Posting
// ============================================================

export async function postMessage(params: {
  threadId: number;
  senderId: number | null;
  body: string;
  planId?: number | null;
  isAi?: boolean;
  replyTo?: number | null;
}): Promise<number> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    `INSERT INTO messages (thread_id, sender_id, body, plan_id, is_ai, reply_to)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      params.threadId,
      params.senderId,
      params.body,
      params.planId ?? null,
      params.isAi === true,
      params.replyTo ?? null,
    ]
  );
  await pool.query("UPDATE message_threads SET updated_at = NOW() WHERE id = $1", [params.threadId]);
  return Number(res.rows[0].id);
}

/** A message's thread + whether it's an @dewey message (for reply handling). */
export async function getMessageBrief(
  messageId: number
): Promise<{ thread_id: number; is_ai: boolean } | null> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    "SELECT thread_id, is_ai FROM messages WHERE id = $1 AND deleted_at IS NULL",
    [messageId]
  );
  const r = res.rows[0];
  return r ? { thread_id: r.thread_id as number, is_ai: r.is_ai === true } : null;
}

/** Soft-delete a message (used to dismiss an attached plan). */
export async function deleteMessage(messageId: number): Promise<void> {
  const pool = getPool();
  await ensureSchema();
  await pool.query("UPDATE messages SET deleted_at = NOW() WHERE id = $1", [messageId]);
}

/**
 * Embed a plan in a partnership thread: duplicate the source into a partnership-
 * scoped copy and post a plan message. Coach (thread creator) only.
 */
export async function addPlanToPartnership(
  threadId: number,
  coachId: number,
  sourcePlanId: number
): Promise<{ ok: boolean; error?: string }> {
  const pool = getPool();
  await ensureSchema();
  const meta = await pool.query(
    "SELECT kind, created_by FROM message_threads WHERE id = $1 AND deleted_at IS NULL",
    [threadId]
  );
  const t = meta.rows[0];
  if (!t || t.kind !== "partnership") return { ok: false, error: "Not a partnership" };
  if (t.created_by !== coachId) return { ok: false, error: "Only the coach can add a plan" };
  if (await threadHasAcceptedPlan(threadId)) {
    return { ok: false, error: "A plan has already been accepted for this partnership and is locked." };
  }

  const copy = await duplicatePlanForPartnership(sourcePlanId, coachId, threadId);
  if (!copy) return { ok: false, error: "Plan not available" };
  // A newly added plan supersedes any earlier plan in the thread.
  await deactivatePriorThreadPlans(threadId, copy.id);
  // Post it like an @dewey suggestion so it has the same accept/edit/dismiss
  // affordances and the coach can ask @dewey to adjust it.
  await postMessage({
    threadId,
    senderId: null,
    isAi: true,
    body: `Here's the plan "${copy.name}" from the library. Accept, edit, or dismiss it — or ask me to adjust it.`,
    planId: copy.id,
  });
  return { ok: true };
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
