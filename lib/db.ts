import { getPool } from "@/lib/pg";
import { hashPassword } from "@/lib/password";
import type { CoachingTemplate, TemplateGraph, TemplateScope } from "@/lib/templates";
import type { MessagePermissions, RoleMessagePerms } from "@/lib/settings";
import { EMPTY_GRAPH } from "@/lib/templates";
import { nextNodeId, isLastInPhase, phaseIdOfNode } from "@/lib/plan-graph";

// ============================================================
// Types
// ============================================================

export type SystemRole = "admin" | "coach" | "partner";

export interface District {
  id: number;
  name: string;
  created_at: string;
}

export interface School {
  id: number;
  district_id: number;
  name: string;
  created_at: string;
}

export interface User {
  id: number;
  username: string;
  full_name: string;
  nickname: string | null;
  email: string | null;
  system_role: SystemRole;
  district_id: number | null;
  /** Legacy "primary" building (first of school_ids); null = district-wide. */
  school_id: number | null;
  /** All buildings this user belongs to. Empty (with a district) = district-wide. */
  school_ids: number[];
  role: string | null;
  about: string | null;
  settings: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** Shape returned to clients — never includes password_hash. */
function rowToUser(row: Record<string, unknown>): User {
  return {
    id: row.id as number,
    username: row.username as string,
    full_name: row.full_name as string,
    nickname: (row.nickname as string | null) ?? null,
    email: (row.email as string | null) ?? null,
    system_role: (row.system_role as SystemRole) ?? "partner",
    district_id: (row.district_id as number | null) ?? null,
    school_id: (row.school_id as number | null) ?? null,
    school_ids: Array.isArray(row.school_ids)
      ? (row.school_ids as number[]).filter((n) => n != null)
      : [],
    role: (row.role as string | null) ?? null,
    about: (row.about as string | null) ?? null,
    settings: (row.settings as Record<string, unknown>) ?? {},
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

function toIso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

const USER_COLUMNS =
  "id, username, full_name, nickname, email, system_role, district_id, school_id, role, about, settings, created_at, updated_at";

// ============================================================
// Schema bootstrap (idempotent)
// ============================================================
// Mirrors docs/db/schema.sql. Runs once per process on first DB access so a
// fresh database is usable without a manual psql step. CREATE TABLE IF NOT
// EXISTS keeps it safe to run repeatedly.

let schemaPromise: Promise<void> | null = null;

export function ensureSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const pool = getPool();
      await pool.query(`
        CREATE TABLE IF NOT EXISTS districts (
          id         SERIAL PRIMARY KEY,
          name       TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS schools (
          id          SERIAL PRIMARY KEY,
          district_id INTEGER NOT NULL REFERENCES districts (id) ON DELETE CASCADE,
          name        TEXT NOT NULL,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS users (
          id             SERIAL PRIMARY KEY,
          username       TEXT NOT NULL,
          password_hash  TEXT NOT NULL,
          full_name      TEXT NOT NULL,
          nickname       TEXT,
          email          TEXT,
          system_role    TEXT NOT NULL DEFAULT 'partner'
                           CHECK (system_role IN ('admin', 'coach', 'partner')),
          district_id    INTEGER REFERENCES districts (id) ON DELETE SET NULL,
          school_id      INTEGER REFERENCES schools (id) ON DELETE SET NULL,
          role           TEXT,
          about          TEXT,
          settings       JSONB NOT NULL DEFAULT '{}',
          created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users (LOWER(username));

        CREATE TABLE IF NOT EXISTS system_settings (
          id                           INTEGER PRIMARY KEY DEFAULT 1
                                         CHECK (id = 1),
          ollama_url                   TEXT,
          ollama_compliance_model      TEXT,
          ollama_coaching_model        TEXT,
          anthropic_api_key            TEXT,
          rag_url                      TEXT,
          rag_default_threshold        DOUBLE PRECISION DEFAULT 0.5,
          rag_default_collections      JSONB NOT NULL DEFAULT '[]',
          default_theme                TEXT DEFAULT 'light',
          settings                     JSONB NOT NULL DEFAULT '{}',
          updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        -- Added after the original schema; ADD COLUMN IF NOT EXISTS makes the
        -- bootstrap safe to run against databases created before this column.
        ALTER TABLE system_settings
          ADD COLUMN IF NOT EXISTS rag_default_collections JSONB NOT NULL DEFAULT '[]';

        -- The classification model slot is now the compliance model. Rename on
        -- upgrade; ADD ensures the column exists either way.
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name = 'system_settings' AND column_name = 'ollama_classification_model')
             AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name = 'system_settings' AND column_name = 'ollama_compliance_model') THEN
            ALTER TABLE system_settings RENAME COLUMN ollama_classification_model TO ollama_compliance_model;
          END IF;
        END $$;
        ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS ollama_compliance_model TEXT;
        -- Ollama context-window ceiling (num_ctx). NULL/0 = use each model's max.
        ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS ollama_num_ctx INTEGER;

        -- Per-user audit log. user_id is the subject; actor_id is who did it
        -- (null for system/self events). Cascades away with the user.
        CREATE TABLE IF NOT EXISTS user_logs (
          id         BIGSERIAL PRIMARY KEY,
          user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
          actor_id   INTEGER REFERENCES users (id) ON DELETE SET NULL,
          action     TEXT NOT NULL,
          detail     TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_user_logs_user
          ON user_logs (user_id, created_at DESC);

        -- Optional reference to the entity an action concerns (template, message,
        -- user, …) so the log UI can deep-link to it. No FK: the entity may be
        -- deleted while its historical label remains useful.
        ALTER TABLE user_logs ADD COLUMN IF NOT EXISTS entity_type TEXT;
        ALTER TABLE user_logs ADD COLUMN IF NOT EXISTS entity_id INTEGER;
        ALTER TABLE user_logs ADD COLUMN IF NOT EXISTS entity_label TEXT;

        -- Coaching templates: an arc-level canvas (activities + flow + phases)
        -- authored by an admin and available to all coaches. The canvas graph
        -- is stored as JSONB (see lib/templates.ts for its shape).
        CREATE TABLE IF NOT EXISTS coaching_templates (
          id          SERIAL PRIMARY KEY,
          name        TEXT NOT NULL,
          description TEXT,
          graph       JSONB NOT NULL DEFAULT '{"nodes":[],"edges":[],"phases":[]}',
          created_by  INTEGER REFERENCES users (id) ON DELETE SET NULL,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        -- Template visibility (added after the original schema). 'global'
        -- templates are admin-authored and visible to all coaches; 'personal'
        -- templates belong to the owning coach. Pre-existing rows default to
        -- 'global', preserving the original "available to all coaches" behavior.
        ALTER TABLE coaching_templates
          ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'global'
            CHECK (scope IN ('global', 'personal'));
        ALTER TABLE coaching_templates
          ADD COLUMN IF NOT EXISTS owner_id INTEGER REFERENCES users (id) ON DELETE CASCADE;

        CREATE INDEX IF NOT EXISTS idx_coaching_templates_owner
          ON coaching_templates (owner_id);

        -- Drop the original scope CHECK so the 'partnership' scope (a plan copy
        -- embedded in a partnership chat, not listed anywhere) is allowed.
        DO $$
        DECLARE cname text;
        BEGIN
          SELECT conname INTO cname FROM pg_constraint
            WHERE conrelid = 'coaching_templates'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) ILIKE '%scope%';
          IF cname IS NOT NULL THEN
            EXECUTE 'ALTER TABLE coaching_templates DROP CONSTRAINT ' || quote_ident(cname);
          END IF;
        END $$;

        -- Soft delete: nothing is ever hard-deleted. A non-null deleted_at hides
        -- the row from all normal views; admins can restore it (deleted_at = NULL)
        -- from the audit log. Usernames stay reserved while a deleted account
        -- holds them so a restore can't collide.
        ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
        ALTER TABLE districts ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
        ALTER TABLE schools ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
        ALTER TABLE coaching_templates ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

        -- Messaging. A thread groups messages between participants; admins can
        -- read every thread for oversight. 'kind' distinguishes a plain DM, a
        -- template share (coach→coach), a template submission (coach→admin, with
        -- a status), and — later — a partnership thread.
        CREATE TABLE IF NOT EXISTS message_threads (
          id          SERIAL PRIMARY KEY,
          kind        TEXT NOT NULL DEFAULT 'direct',
          subject     TEXT,
          template_id INTEGER REFERENCES coaching_templates (id) ON DELETE SET NULL,
          status      TEXT, -- submissions: 'open' | 'approved' | 'rejected'
          created_by  INTEGER REFERENCES users (id) ON DELETE SET NULL,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          deleted_at  TIMESTAMPTZ
        );

        CREATE TABLE IF NOT EXISTS thread_participants (
          thread_id INTEGER NOT NULL REFERENCES message_threads (id) ON DELETE CASCADE,
          user_id   INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
          PRIMARY KEY (thread_id, user_id)
        );

        -- Partnership-scoped plans link back to their thread (FK needs
        -- message_threads to exist, hence here rather than at table creation).
        ALTER TABLE coaching_templates
          ADD COLUMN IF NOT EXISTS thread_id INTEGER REFERENCES message_threads (id) ON DELETE SET NULL;

        -- Partnership-plan acceptance: a coach must accept an embedded plan
        -- before it becomes the active plan. accepted_at marks acceptance;
        -- current_node_id points at the activity the partner is currently on
        -- (the entry activity at acceptance), used to color canvas progress.
        ALTER TABLE coaching_templates
          ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ;
        ALTER TABLE coaching_templates
          ADD COLUMN IF NOT EXISTS current_node_id TEXT;
        -- A thread holds one live plan: when a newer plan is added or revised,
        -- prior plans in the thread are deactivated (kept visible but inactive).
        ALTER TABLE coaching_templates
          ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;
        -- Outcome of an accepted (active) plan: 'finished' or 'abandoned'. NULL =
        -- in progress. This is about the PLAN, not the thread (archive is separate).
        ALTER TABLE coaching_templates
          ADD COLUMN IF NOT EXISTS outcome TEXT;

        -- Invitation state for partnership threads: NULL = invited/pending,
        -- TRUE = accepted, FALSE = declined. Ignored for non-partnership threads.
        ALTER TABLE thread_participants ADD COLUMN IF NOT EXISTS accepted BOOLEAN;
        -- When the user last read the thread (for unread highlighting).
        ALTER TABLE thread_participants ADD COLUMN IF NOT EXISTS last_read_at TIMESTAMPTZ;

        CREATE TABLE IF NOT EXISTS messages (
          id         BIGSERIAL PRIMARY KEY,
          thread_id  INTEGER NOT NULL REFERENCES message_threads (id) ON DELETE CASCADE,
          sender_id  INTEGER REFERENCES users (id) ON DELETE SET NULL,
          body       TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          deleted_at TIMESTAMPTZ
        );
        CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages (thread_id, created_at);
        -- A message can embed a (partnership-scoped) plan copy.
        ALTER TABLE messages
          ADD COLUMN IF NOT EXISTS plan_id INTEGER REFERENCES coaching_templates (id) ON DELETE SET NULL;
        -- Messages authored by the @dewey assistant (sender_id is null).
        ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_ai BOOLEAN NOT NULL DEFAULT FALSE;
        -- iMessage-style reply: the message this one is a reply to.
        ALTER TABLE messages
          ADD COLUMN IF NOT EXISTS reply_to BIGINT REFERENCES messages (id) ON DELETE SET NULL;
        -- RAG source documents cited by an @dewey reply: [{name, path}].
        ALTER TABLE messages ADD COLUMN IF NOT EXISTS sources JSONB;
        -- Per-recipient visibility. NULL = everyone in the thread sees it. When set
        -- to an array of user ids, only those users (plus any admin, for oversight)
        -- may see it — used for coach review feedback meant for one partner.
        ALTER TABLE messages ADD COLUMN IF NOT EXISTS audience INTEGER[];
        -- Celebratory event marker on auto-posted progress notes: 'advance' (an
        -- activity/phase was completed) or 'finish' (the whole plan finished).
        -- Drives the chat-window fireworks. NULL for ordinary messages.
        ALTER TABLE messages ADD COLUMN IF NOT EXISTS event TEXT;

        -- Activity submissions: a partner marks one chat message as the active
        -- activity's submission. One live row per (plan, node); approved rows are
        -- kept as phase history. gating is snapshotted at submit time.
        CREATE TABLE IF NOT EXISTS activity_submissions (
          id         BIGSERIAL PRIMARY KEY,
          plan_id    INTEGER NOT NULL REFERENCES coaching_templates (id) ON DELETE CASCADE,
          node_id    TEXT NOT NULL,
          phase_id   TEXT,
          partner_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
          message_id BIGINT REFERENCES messages (id) ON DELETE SET NULL,
          gating     TEXT NOT NULL,
          status     TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'returned'
          feedback   TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          decided_at TIMESTAMPTZ,
          decided_by INTEGER REFERENCES users (id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_activity_sub_plan ON activity_submissions (plan_id, node_id);
        CREATE INDEX IF NOT EXISTS idx_activity_sub_message ON activity_submissions (message_id);

        -- Persisted coach⇄Dewey consult about a submission (review modal chat).
        CREATE TABLE IF NOT EXISTS activity_review_consults (
          id            BIGSERIAL PRIMARY KEY,
          submission_id BIGINT NOT NULL REFERENCES activity_submissions (id) ON DELETE CASCADE,
          role          TEXT NOT NULL, -- 'coach' | 'dewey'
          body          TEXT NOT NULL,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_consult_submission ON activity_review_consults (submission_id, id);

        -- Multi-party plan acceptance: an embedded plan becomes active only once
        -- every thread participant has accepted it. One row per (plan, user).
        CREATE TABLE IF NOT EXISTS plan_acceptances (
          plan_id     INTEGER NOT NULL REFERENCES coaching_templates (id) ON DELETE CASCADE,
          user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
          accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (plan_id, user_id)
        );

        -- File attachments live in the DB (BYTEA) so they're covered by the same
        -- backups and need no separate storage volume. Previews are by mime type.
        CREATE TABLE IF NOT EXISTS message_attachments (
          id         BIGSERIAL PRIMARY KEY,
          message_id BIGINT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
          filename   TEXT NOT NULL,
          mime_type  TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          data       BYTEA NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_attachments_message ON message_attachments (message_id);

        -- Per-user thread archiving. A row hides the thread from that user's
        -- active list and surfaces it under "Archived"; it does not affect other
        -- participants. Admins (oversight) can archive their own view too.
        CREATE TABLE IF NOT EXISTS thread_archived (
          thread_id   INTEGER NOT NULL REFERENCES message_threads (id) ON DELETE CASCADE,
          user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
          archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (thread_id, user_id)
        );

        -- Profile photos (one per user), stored in-DB as BYTEA.
        CREATE TABLE IF NOT EXISTS user_avatars (
          user_id    INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
          mime_type  TEXT NOT NULL,
          data       BYTEA NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        -- Persisted AI chat. A conversation is owned by one user and tied to a
        -- context (e.g. a template/plan, later an activity). Every message is
        -- kept forever (the full transcript); summary + summarized_through
        -- compress older turns for the model's context window without losing
        -- anything. Only the owner and admins ever read these.
        CREATE TABLE IF NOT EXISTS ai_conversations (
          id                 SERIAL PRIMARY KEY,
          owner_id           INTEGER REFERENCES users (id) ON DELETE CASCADE,
          context_type       TEXT NOT NULL DEFAULT 'template',
          context_id         INTEGER,
          summary            TEXT,
          summarized_through BIGINT NOT NULL DEFAULT 0,
          created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_ai_conv_owner
          ON ai_conversations (owner_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_ai_conv_context
          ON ai_conversations (owner_id, context_type, context_id);

        CREATE TABLE IF NOT EXISTS ai_messages (
          id              BIGSERIAL PRIMARY KEY,
          conversation_id INTEGER NOT NULL REFERENCES ai_conversations (id) ON DELETE CASCADE,
          role            TEXT NOT NULL,
          content         TEXT NOT NULL,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_ai_messages_conv ON ai_messages (conversation_id, id);
        -- Flagged turns (compliance) are kept in the transcript but excluded from
        -- the model's live context.
        ALTER TABLE ai_messages ADD COLUMN IF NOT EXISTS flagged BOOLEAN NOT NULL DEFAULT FALSE;

        -- A user can belong to multiple buildings (schools). user_schools is the
        -- authoritative set; users.school_id is kept as a denormalized "primary"
        -- building for legacy displays. Zero rows + a district_id = district-wide.
        CREATE TABLE IF NOT EXISTS user_schools (
          user_id   INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
          school_id INTEGER NOT NULL REFERENCES schools (id) ON DELETE CASCADE,
          PRIMARY KEY (user_id, school_id)
        );
        CREATE INDEX IF NOT EXISTS idx_user_schools_school ON user_schools (school_id);

        -- Backfill from the legacy single school_id, but only for users who have
        -- no building rows yet (so it never clobbers multi-building edits).
        INSERT INTO user_schools (user_id, school_id)
          SELECT u.id, u.school_id FROM users u
           WHERE u.school_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM user_schools us WHERE us.user_id = u.id)
          ON CONFLICT DO NOTHING;

        -- Admin-configurable messaging permissions (who coaches/partners can DM).
        ALTER TABLE system_settings
          ADD COLUMN IF NOT EXISTS message_permissions JSONB NOT NULL DEFAULT
            '{"coach":{"partner_same_school":true,"partner_district":false,"coach_same_school":true,"coach_district":true},"partner":{"partner_same_school":false,"partner_district":false,"coach_same_school":true,"coach_district":false}}';
      `);

      // Backfill: the "only the most recent plan per thread is active" rule should
      // apply to threads that predate it. Mark every embedded plan that has a newer
      // sibling in the same thread as superseded. Idempotent (only touches rows not
      // already deactivated), and runs once per process via schemaPromise.
      await pool.query(`
        UPDATE coaching_templates ct
           SET deactivated_at = NOW()
         WHERE ct.scope = 'partnership' AND ct.deleted_at IS NULL
           AND ct.thread_id IS NOT NULL AND ct.deactivated_at IS NULL
           AND EXISTS (
             SELECT 1 FROM coaching_templates newer
              WHERE newer.thread_id = ct.thread_id AND newer.scope = 'partnership'
                AND newer.deleted_at IS NULL
                AND (newer.created_at > ct.created_at
                     OR (newer.created_at = ct.created_at AND newer.id > ct.id))
           );
      `);
    })().catch((e) => {
      // Reset so a transient failure can retry on the next call.
      schemaPromise = null;
      throw e;
    });
  }
  return schemaPromise;
}

// ============================================================
// Districts
// ============================================================

export async function getDistricts(): Promise<District[]> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    "SELECT id, name, created_at FROM districts WHERE deleted_at IS NULL ORDER BY name"
  );
  return res.rows.map((r) => ({ id: r.id, name: r.name, created_at: toIso(r.created_at) }));
}

export async function createDistrict(name: string): Promise<District> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    "INSERT INTO districts (name) VALUES ($1) RETURNING id, name, created_at",
    [name.trim()]
  );
  const r = res.rows[0];
  return { id: r.id, name: r.name, created_at: toIso(r.created_at) };
}

/** Soft-delete a district (hide it). Its schools/users keep their references. */
export async function deleteDistrict(id: number): Promise<boolean> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    "UPDATE districts SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL",
    [id]
  );
  return (res.rowCount ?? 0) > 0;
}

export async function restoreDistrict(id: number): Promise<boolean> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query("UPDATE districts SET deleted_at = NULL WHERE id = $1", [id]);
  return (res.rowCount ?? 0) > 0;
}

// ============================================================
// Schools
// ============================================================

export async function getSchools(districtId?: number): Promise<School[]> {
  const pool = getPool();
  await ensureSchema();
  const res = districtId
    ? await pool.query(
        "SELECT id, district_id, name, created_at FROM schools WHERE district_id = $1 AND deleted_at IS NULL ORDER BY name",
        [districtId]
      )
    : await pool.query(
        "SELECT id, district_id, name, created_at FROM schools WHERE deleted_at IS NULL ORDER BY name"
      );
  return res.rows.map((r) => ({
    id: r.id,
    district_id: r.district_id,
    name: r.name,
    created_at: toIso(r.created_at),
  }));
}

export async function createSchool(districtId: number, name: string): Promise<School> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    "INSERT INTO schools (district_id, name) VALUES ($1, $2) RETURNING id, district_id, name, created_at",
    [districtId, name.trim()]
  );
  const r = res.rows[0];
  return { id: r.id, district_id: r.district_id, name: r.name, created_at: toIso(r.created_at) };
}

/** Soft-delete a school (hide it). Users keep their school reference. */
export async function deleteSchool(id: number): Promise<boolean> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    "UPDATE schools SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL",
    [id]
  );
  return (res.rowCount ?? 0) > 0;
}

export async function restoreSchool(id: number): Promise<boolean> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query("UPDATE schools SET deleted_at = NULL WHERE id = $1", [id]);
  return (res.rowCount ?? 0) > 0;
}

// ============================================================
// Users
// ============================================================

/** Count of admin accounts. Drives first-run setup detection. */
export async function getAdminCount(): Promise<number> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    "SELECT COUNT(*)::int AS n FROM users WHERE system_role = 'admin' AND deleted_at IS NULL"
  );
  return res.rows[0]?.n ?? 0;
}

export async function hasAdmin(): Promise<boolean> {
  return (await getAdminCount()) > 0;
}

/** Populate each user's school_ids (their buildings) in one batch query. */
async function attachSchoolIds(users: User[]): Promise<User[]> {
  if (users.length === 0) return users;
  const pool = getPool();
  const ids = users.map((u) => u.id);
  const res = await pool.query(
    "SELECT user_id, school_id FROM user_schools WHERE user_id = ANY($1::int[]) ORDER BY school_id",
    [ids]
  );
  const byUser = new Map<number, number[]>();
  for (const r of res.rows) {
    const list = byUser.get(r.user_id) ?? [];
    list.push(r.school_id as number);
    byUser.set(r.user_id, list);
  }
  for (const u of users) u.school_ids = byUser.get(u.id) ?? [];
  return users;
}

export async function getUserSchoolIds(userId: number): Promise<number[]> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    "SELECT school_id FROM user_schools WHERE user_id = $1 ORDER BY school_id",
    [userId]
  );
  return res.rows.map((r) => r.school_id as number);
}

/** Replace a user's buildings and keep users.school_id synced to the primary. */
export async function setUserSchools(userId: number, schoolIds: number[]): Promise<void> {
  const pool = getPool();
  await ensureSchema();
  const ids = Array.from(new Set(schoolIds.filter((n) => Number.isFinite(n))));
  await pool.query("DELETE FROM user_schools WHERE user_id = $1", [userId]);
  for (const sid of ids) {
    await pool.query(
      "INSERT INTO user_schools (user_id, school_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [userId, sid]
    );
  }
  await pool.query("UPDATE users SET school_id = $2, updated_at = NOW() WHERE id = $1", [
    userId,
    ids[0] ?? null,
  ]);
}

export async function getAllUsers(): Promise<User[]> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    `SELECT ${USER_COLUMNS} FROM users WHERE deleted_at IS NULL ORDER BY id`
  );
  return attachSchoolIds(res.rows.map(rowToUser));
}

export async function getUserById(id: number): Promise<User | null> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    `SELECT ${USER_COLUMNS} FROM users WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
    [id]
  );
  if (!res.rows[0]) return null;
  return (await attachSchoolIds([rowToUser(res.rows[0])]))[0];
}

/** Includes password_hash — for auth only. Never expose this shape to clients. */
export async function getUserWithHashByUsername(
  username: string
): Promise<(User & { password_hash: string }) | null> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    `SELECT ${USER_COLUMNS}, password_hash FROM users
      WHERE LOWER(username) = LOWER($1) AND deleted_at IS NULL LIMIT 1`,
    [username.trim()]
  );
  const row = res.rows[0];
  if (!row) return null;
  return { ...rowToUser(row), password_hash: row.password_hash as string };
}

export interface CreateUserParams {
  username: string;
  password: string;
  full_name: string;
  nickname?: string | null;
  email?: string | null;
  system_role: SystemRole;
  district_id?: number | null;
  school_id?: number | null;
  /** Buildings the user belongs to. Empty (with a district) = district-wide. */
  school_ids?: number[];
  role?: string | null;
  about?: string | null;
}

export async function createUser(params: CreateUserParams): Promise<User> {
  const pool = getPool();
  await ensureSchema();
  const username = params.username.trim();
  if (!username) throw new Error("Username is required");
  if (!params.full_name?.trim()) throw new Error("Full name is required");
  // Check across ALL rows (including soft-deleted) — usernames stay reserved
  // while a hidden account holds them, so a later restore can't collide.
  const taken = await pool.query(
    "SELECT 1 FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1",
    [username]
  );
  if (taken.rows.length > 0) {
    throw new Error(
      "Username already taken (it may belong to a hidden account — restore it from the audit log)."
    );
  }
  const password_hash = await hashPassword(params.password);
  const res = await pool.query(
    `INSERT INTO users
       (username, password_hash, full_name, nickname, email, system_role, district_id, school_id, role, about)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING ${USER_COLUMNS}`,
    [
      username,
      password_hash,
      params.full_name.trim(),
      params.nickname?.trim() || null,
      params.email?.trim() || null,
      params.system_role,
      params.district_id ?? null,
      params.school_id ?? null,
      params.role?.trim() || null,
      params.about ?? null,
    ]
  );
  const created = rowToUser(res.rows[0]);
  // Buildings: explicit school_ids win; otherwise mirror the legacy single school.
  const buildings =
    params.school_ids ?? (params.school_id != null ? [params.school_id] : []);
  await setUserSchools(created.id, buildings);
  return (await getUserById(created.id)) ?? created;
}

export interface UpdateUserParams {
  full_name?: string;
  nickname?: string | null;
  email?: string | null;
  system_role?: SystemRole;
  district_id?: number | null;
  school_id?: number | null;
  /** Replace the user's buildings. Empty (with a district) = district-wide. */
  schoolIds?: number[];
  role?: string | null;
  about?: string | null;
  password?: string;
  /**
   * Per-user RAG collection override, stored in users.settings.ragCollections.
   * `undefined` = leave unchanged; an array = override the system defaults;
   * `null` = clear the override so the user inherits the system defaults.
   */
  ragCollectionsOverride?: string[] | null;
}

export async function updateUser(id: number, params: UpdateUserParams): Promise<User> {
  const pool = getPool();
  await ensureSchema();
  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  const push = (col: string, val: unknown) => {
    sets.push(`${col} = $${i++}`);
    values.push(val);
  };

  if (params.full_name !== undefined) push("full_name", params.full_name.trim());
  if (params.nickname !== undefined) push("nickname", params.nickname?.trim() || null);
  if (params.email !== undefined) push("email", params.email?.trim() || null);
  if (params.system_role !== undefined) push("system_role", params.system_role);
  if (params.district_id !== undefined) push("district_id", params.district_id);
  // school_id is synced by setUserSchools when schoolIds is given; only honor the
  // legacy single school_id when no building set is provided.
  if (params.school_id !== undefined && params.schoolIds === undefined)
    push("school_id", params.school_id);
  if (params.role !== undefined) push("role", params.role?.trim() || null);
  if (params.about !== undefined) push("about", params.about);
  if (params.password) push("password_hash", await hashPassword(params.password));

  // RAG collection override lives in the settings JSONB.
  if (params.ragCollectionsOverride !== undefined) {
    if (params.ragCollectionsOverride === null) {
      sets.push(`settings = settings - 'ragCollections'`);
    } else {
      sets.push(`settings = jsonb_set(settings, '{ragCollections}', $${i++}::jsonb, true)`);
      values.push(JSON.stringify(params.ragCollectionsOverride));
    }
  }

  if (sets.length > 0) {
    sets.push("updated_at = NOW()");
    values.push(id);
    const res = await pool.query(
      `UPDATE users SET ${sets.join(", ")} WHERE id = $${i} RETURNING id`,
      values
    );
    if (!res.rows[0]) throw new Error("User not found");
  }

  // Apply the building set (also syncs the primary school_id).
  if (params.schoolIds !== undefined) {
    await setUserSchools(id, params.schoolIds);
  }

  const updated = await getUserById(id);
  if (!updated) throw new Error("User not found");
  return updated;
}

/** Soft-delete a user (hide the account). The username stays reserved. */
export async function deleteUser(id: number): Promise<boolean> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    "UPDATE users SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1 AND deleted_at IS NULL",
    [id]
  );
  return (res.rowCount ?? 0) > 0;
}

export async function restoreUser(id: number): Promise<boolean> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    "UPDATE users SET deleted_at = NULL, updated_at = NOW() WHERE id = $1",
    [id]
  );
  return (res.rowCount ?? 0) > 0;
}

// ============================================================
// Coach partner directory
// ============================================================

export interface DirectoryPartner extends User {
  district_name: string | null;
  school_names: string[];
}

interface DistrictUserRow {
  id: number;
  full_name: string;
  username: string;
  nickname: string | null;
  email: string | null;
  role: string | null;
  about: string | null;
  system_role: SystemRole;
  district_name: string | null;
  school_ids: number[];
  school_names: string[];
}

/** Users in a district (coaches/partners) with their building ids + names. */
async function getDistrictUsersWithBuildings(
  districtId: number,
  excludeUserId: number,
  roles: SystemRole[]
): Promise<DistrictUserRow[]> {
  const pool = getPool();
  const res = await pool.query(
    `SELECT u.id, u.full_name, u.username, u.nickname, u.email, u.role, u.about,
            u.system_role, d.name AS district_name,
            COALESCE(array_agg(us.school_id) FILTER (WHERE us.school_id IS NOT NULL), '{}') AS school_ids,
            COALESCE(array_agg(s.name)       FILTER (WHERE s.name IS NOT NULL), '{}')      AS school_names
       FROM users u
       LEFT JOIN districts d ON d.id = u.district_id
       LEFT JOIN user_schools us ON us.user_id = u.id
       LEFT JOIN schools s ON s.id = us.school_id
      WHERE u.deleted_at IS NULL AND u.id <> $1 AND u.district_id = $2
        AND u.system_role = ANY($3::text[])
      GROUP BY u.id, d.name
      ORDER BY u.full_name`,
    [excludeUserId, districtId, roles]
  );
  return res.rows.map((r) => ({
    id: r.id as number,
    full_name: r.full_name as string,
    username: r.username as string,
    nickname: (r.nickname as string | null) ?? null,
    email: (r.email as string | null) ?? null,
    role: (r.role as string | null) ?? null,
    about: (r.about as string | null) ?? null,
    system_role: r.system_role as SystemRole,
    district_name: (r.district_name as string | null) ?? null,
    school_ids: (r.school_ids as number[]) ?? [],
    school_names: (r.school_names as string[]) ?? [],
  }));
}

/**
 * Partners visible to a coach: those who share at least one building with the
 * coach. (To reach everyone in a district, assign all buildings.) Returns the
 * partners with building names, the coach's buildings for filtering, and scope.
 */
export async function getCoachDirectory(coach: {
  id: number;
  district_id: number | null;
}): Promise<{
  partners: DirectoryPartner[];
  schools: School[];
  scope: "school" | "none";
}> {
  await ensureSchema();
  if (coach.district_id == null) {
    return { partners: [], schools: [], scope: "none" };
  }

  const coachBuildings = await getUserSchoolIds(coach.id);
  const rows = await getDistrictUsersWithBuildings(coach.district_id, coach.id, ["partner"]);

  const coachSet = new Set(coachBuildings);
  const visible = rows.filter((r) => r.school_ids.some((sid) => coachSet.has(sid)));

  const partners: DirectoryPartner[] = visible.map((r) => ({
    id: r.id,
    username: r.username,
    full_name: r.full_name,
    nickname: r.nickname,
    email: r.email,
    system_role: r.system_role,
    district_id: coach.district_id,
    school_id: r.school_ids[0] ?? null,
    school_ids: r.school_ids,
    role: r.role,
    about: r.about,
    settings: {},
    created_at: "",
    updated_at: "",
    district_name: r.district_name,
    school_names: r.school_names,
  }));

  // The coach's own buildings, for narrowing the directory.
  const allSchools = await getSchools(coach.district_id);
  const schools = allSchools.filter((s) => coachSet.has(s.id));
  return { partners, schools, scope: "school" };
}

/** Other coaches in the same district (for the "share a template" picker). */
export async function getCoachesInDistrict(
  coachId: number
): Promise<{ id: number; full_name: string; school_id: number | null }[]> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    `SELECT u2.id, u2.full_name, u2.school_id
       FROM users u1
       JOIN users u2 ON u2.district_id = u1.district_id
      WHERE u1.id = $1
        AND u1.district_id IS NOT NULL
        AND u2.system_role = 'coach'
        AND u2.id <> u1.id
        AND u2.deleted_at IS NULL
      ORDER BY u2.full_name`,
    [coachId]
  );
  return res.rows.map((r) => ({
    id: r.id as number,
    full_name: r.full_name as string,
    school_id: (r.school_id as number | null) ?? null,
  }));
}

export interface RecipientOption {
  id: number;
  full_name: string;
  username: string;
  system_role: SystemRole;
  district_name: string | null;
  school_names: string[];
}

/** All admin accounts as recipient options (everyone can message an admin). */
async function getAdminRecipients(excludeUserId: number): Promise<RecipientOption[]> {
  const pool = getPool();
  const res = await pool.query(
    `SELECT u.id, u.full_name, u.username, u.system_role, d.name AS district_name
       FROM users u LEFT JOIN districts d ON d.id = u.district_id
      WHERE u.deleted_at IS NULL AND u.system_role = 'admin' AND u.id <> $1
      ORDER BY u.full_name`,
    [excludeUserId]
  );
  return res.rows.map((r) => ({
    id: r.id as number,
    full_name: r.full_name as string,
    username: r.username as string,
    system_role: r.system_role as SystemRole,
    district_name: (r.district_name as string | null) ?? null,
    school_names: [],
  }));
}

/**
 * Users the given user may start a message thread with, governed by the admin's
 * messaging-permission matrix and building membership:
 *   - admin   → anyone
 *   - coach/partner → admins (always), plus the partners/coaches allowed by the
 *     matrix. "same school" = shares ≥1 building (a district-wide member, with no
 *     specific building, counts as sharing). "district" = anyone in the district.
 */
export async function getMessageRecipients(
  meId: number,
  permissions: MessagePermissions
): Promise<RecipientOption[]> {
  await ensureSchema();
  const me = await getUserById(meId);
  if (!me) return [];

  if (me.system_role === "admin") {
    const pool = getPool();
    const res = await pool.query(
      `SELECT u.id, u.full_name, u.username, u.system_role, d.name AS district_name,
              COALESCE(array_agg(s.name) FILTER (WHERE s.name IS NOT NULL), '{}') AS school_names
         FROM users u
         LEFT JOIN districts d ON d.id = u.district_id
         LEFT JOIN user_schools us ON us.user_id = u.id
         LEFT JOIN schools s ON s.id = us.school_id
        WHERE u.deleted_at IS NULL AND u.id <> $1
        GROUP BY u.id, d.name
        ORDER BY u.full_name`,
      [meId]
    );
    return res.rows.map((r) => ({
      id: r.id as number,
      full_name: r.full_name as string,
      username: r.username as string,
      system_role: r.system_role as SystemRole,
      district_name: (r.district_name as string | null) ?? null,
      school_names: (r.school_names as string[]) ?? [],
    }));
  }

  const out = new Map<number, RecipientOption>();
  // Everyone can message an admin.
  for (const a of await getAdminRecipients(meId)) out.set(a.id, a);

  const perms: RoleMessagePerms | undefined =
    me.system_role === "coach" || me.system_role === "partner"
      ? permissions[me.system_role]
      : undefined;
  if (perms && me.district_id != null) {
    const myBuildings = new Set(me.school_ids);
    const rows = await getDistrictUsersWithBuildings(me.district_id, meId, ["coach", "partner"]);
    for (const r of rows) {
      const role = r.system_role === "coach" ? "coach" : "partner";
      const districtAllowed = perms[`${role}_district`];
      const sameSchoolAllowed = perms[`${role}_same_school`];
      // "Same school" = genuinely shares a building (assign all buildings to
      // reach everyone in the district).
      const sharesBuilding = r.school_ids.some((s) => myBuildings.has(s));
      if (districtAllowed || (sameSchoolAllowed && sharesBuilding)) {
        out.set(r.id, {
          id: r.id,
          full_name: r.full_name,
          username: r.username,
          system_role: r.system_role,
          district_name: r.district_name,
          school_names: r.school_names,
        });
      }
    }
  }

  return Array.from(out.values()).sort((a, b) => a.full_name.localeCompare(b.full_name));
}

// ============================================================
// Profile photos
// ============================================================

export async function setUserAvatar(
  userId: number,
  mimeType: string,
  data: Buffer
): Promise<void> {
  const pool = getPool();
  await ensureSchema();
  await pool.query(
    `INSERT INTO user_avatars (user_id, mime_type, data, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id) DO UPDATE
       SET mime_type = EXCLUDED.mime_type, data = EXCLUDED.data, updated_at = NOW()`,
    [userId, mimeType, data]
  );
}

export async function getUserAvatar(
  userId: number
): Promise<{ mimeType: string; data: Buffer } | null> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    "SELECT mime_type, data FROM user_avatars WHERE user_id = $1 LIMIT 1",
    [userId]
  );
  const r = res.rows[0];
  return r ? { mimeType: r.mime_type as string, data: r.data as Buffer } : null;
}

export async function deleteUserAvatar(userId: number): Promise<void> {
  const pool = getPool();
  await ensureSchema();
  await pool.query("DELETE FROM user_avatars WHERE user_id = $1", [userId]);
}

/** All admin user ids (participants for template submissions). */
export async function getAdminIds(): Promise<number[]> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    "SELECT id FROM users WHERE system_role = 'admin' AND deleted_at IS NULL"
  );
  return res.rows.map((r) => r.id as number);
}

// ============================================================
// Coaching templates
// ============================================================

function rowToTemplate(row: Record<string, unknown>): CoachingTemplate {
  const graph = (row.graph as TemplateGraph) ?? EMPTY_GRAPH;
  return {
    id: row.id as number,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    graph: {
      nodes: Array.isArray(graph.nodes) ? graph.nodes : [],
      edges: Array.isArray(graph.edges) ? graph.edges : [],
      phases: Array.isArray(graph.phases) ? graph.phases : [],
    },
    scope: ((["personal", "partnership"].includes(row.scope as string)
      ? row.scope
      : "global") as TemplateScope),
    owner_id: (row.owner_id as number | null) ?? null,
    created_by: (row.created_by as number | null) ?? null,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    deleted_at: row.deleted_at ? toIso(row.deleted_at) : null,
    accepted_at: row.accepted_at ? toIso(row.accepted_at) : null,
    current_node_id: (row.current_node_id as string | null) ?? null,
    deactivated_at: row.deactivated_at ? toIso(row.deactivated_at) : null,
    thread_id: (row.thread_id as number | null) ?? null,
    submission_status: (row.submission_status as "open" | "approved" | "rejected" | null) ?? null,
    outcome: (row.outcome as "finished" | "abandoned" | null) ?? null,
  };
}

/** Admin-facing list: the global templates available to every coach. */
export async function getTemplates(): Promise<CoachingTemplate[]> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    "SELECT * FROM coaching_templates WHERE scope = 'global' AND deleted_at IS NULL ORDER BY name"
  );
  return res.rows.map(rowToTemplate);
}

/** Coach-facing list: every global template plus the coach's own personal ones. */
export async function getTemplatesForCoach(coachId: number): Promise<CoachingTemplate[]> {
  const pool = getPool();
  await ensureSchema();
  // Partnership-scoped copies are deliberately excluded — they live only in the
  // partnership chat, not in any plan list. submission_status reflects the latest
  // district-submission thread for the plan (so approve/reject in the message
  // center shows up here too).
  const res = await pool.query(
    `SELECT ct.*,
            (SELECT st.status FROM message_threads st
              WHERE st.kind = 'template_submission' AND st.template_id = ct.id
                AND st.deleted_at IS NULL
              ORDER BY st.created_at DESC LIMIT 1) AS submission_status
       FROM coaching_templates ct
      WHERE ct.deleted_at IS NULL
        AND (ct.scope = 'global' OR (ct.scope = 'personal' AND ct.owner_id = $1))
      ORDER BY ct.scope = 'global' DESC, ct.name`,
    [coachId]
  );
  return res.rows.map(rowToTemplate);
}

/**
 * Load a template a coach is allowed to see: their own personal one, or any
 * global template (read-only to them). Returns null if it exists but is another
 * coach's personal template.
 */
export async function getTemplateForCoach(
  id: number,
  coachId: number
): Promise<CoachingTemplate | null> {
  const t = await getTemplate(id);
  if (!t || t.deleted_at) return null; // coaches never see hidden templates
  if (t.scope === "global") return t;
  return t.owner_id === coachId ? t : null;
}

export async function getTemplate(id: number): Promise<CoachingTemplate | null> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query("SELECT * FROM coaching_templates WHERE id = $1 LIMIT 1", [id]);
  return res.rows[0] ? rowToTemplate(res.rows[0]) : null;
}

export async function createTemplate(params: {
  name: string;
  description?: string | null;
  graph?: TemplateGraph;
  createdBy?: number | null;
  scope?: TemplateScope;
  ownerId?: number | null;
  threadId?: number | null;
}): Promise<CoachingTemplate> {
  const pool = getPool();
  await ensureSchema();
  const scope: TemplateScope = params.scope ?? "global";
  const res = await pool.query(
    `INSERT INTO coaching_templates (name, description, graph, created_by, scope, owner_id, thread_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      params.name.trim(),
      params.description?.trim() || null,
      JSON.stringify(params.graph ?? EMPTY_GRAPH),
      params.createdBy ?? null,
      scope,
      scope === "global" ? null : params.ownerId ?? null,
      params.threadId ?? null,
    ]
  );
  return rowToTemplate(res.rows[0]);
}

/**
 * Duplicate a plan (the coach's own or a global one) into a partnership-scoped
 * copy owned by the coach and linked to the thread. Returns null if the source
 * isn't visible to the coach.
 */
export async function duplicatePlanForPartnership(
  sourceId: number,
  coachId: number,
  threadId: number
): Promise<CoachingTemplate | null> {
  const source = await getTemplateForCoach(sourceId, coachId);
  if (!source) return null;
  return createTemplate({
    name: source.name,
    description: source.description,
    graph: source.graph,
    createdBy: coachId,
    scope: "partnership",
    ownerId: coachId,
    threadId,
  });
}

/** Load a partnership plan if the user participates in its thread (or is admin). */
export async function getPlanForThreadMember(
  planId: number,
  userId: number,
  isAdmin: boolean
): Promise<CoachingTemplate | null> {
  const pool = getPool();
  await ensureSchema();
  const t = await getTemplate(planId);
  if (!t || t.deleted_at || t.scope !== "partnership") return null;
  if (isAdmin) return t;
  // Must be a participant of the plan's thread.
  const res = await pool.query(
    `SELECT 1 FROM coaching_templates ct
       JOIN thread_participants p ON p.thread_id = ct.thread_id AND p.user_id = $2
      WHERE ct.id = $1 LIMIT 1`,
    [planId, userId]
  );
  return res.rows[0] ? t : null;
}

/**
 * The entry activity of a graph: the node with no incoming edge (the start of
 * the arc). Falls back to the first node in graph order.
 */
function entryNodeId(graph: TemplateGraph): string | null {
  const nodes = graph.nodes ?? [];
  if (nodes.length === 0) return null;
  const hasIncoming = new Set((graph.edges ?? []).map((e) => e.target));
  const entry = nodes.find((n) => !hasIncoming.has(n.id));
  return (entry ?? nodes[0]).id;
}

/**
 * Deactivate every partnership plan in a thread except `keepId`: a thread holds
 * one live plan, so adding/revising a plan supersedes the rest. Deactivated
 * plans stay visible in the chat but are no longer acceptable/active.
 */
export async function deactivatePriorThreadPlans(
  threadId: number,
  keepId: number
): Promise<void> {
  const pool = getPool();
  await ensureSchema();
  // Drop pending acceptances on the plans we're about to supersede. Terminal
  // plans (finished/abandoned) are left intact as history.
  await pool.query(
    `DELETE FROM plan_acceptances WHERE plan_id IN (
       SELECT id FROM coaching_templates
        WHERE thread_id = $1 AND id <> $2 AND scope = 'partnership' AND deleted_at IS NULL
          AND outcome IS NULL)`,
    [threadId, keepId]
  );
  await pool.query(
    `UPDATE coaching_templates
        SET deactivated_at = NOW(), accepted_at = NULL, current_node_id = NULL, updated_at = NOW()
      WHERE thread_id = $1 AND id <> $2 AND scope = 'partnership'
        AND deleted_at IS NULL AND deactivated_at IS NULL AND outcome IS NULL`,
    [threadId, keepId]
  );
}

/**
 * Whether a thread has an ACTIVE locked-in plan (accepted + still in progress).
 * A finished/abandoned plan doesn't count — the coach is free to add the next one.
 */
export async function threadHasAcceptedPlan(threadId: number): Promise<boolean> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    `SELECT 1 FROM coaching_templates
      WHERE thread_id = $1 AND scope = 'partnership'
        AND deleted_at IS NULL AND accepted_at IS NOT NULL AND outcome IS NULL
      LIMIT 1`,
    [threadId]
  );
  return res.rows.length > 0;
}

/**
 * Whether a thread has a LIVE plan — the current (non-superseded, non-terminal)
 * one, whether pending or accepted. Used to stop a partner from archiving a
 * conversation that still has an active plan.
 */
export async function threadHasLivePlan(threadId: number): Promise<boolean> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    `SELECT 1 FROM coaching_templates
      WHERE thread_id = $1 AND scope = 'partnership'
        AND deleted_at IS NULL AND deactivated_at IS NULL AND outcome IS NULL
      LIMIT 1`,
    [threadId]
  );
  return res.rows.length > 0;
}

/**
 * Mark an accepted plan finished or abandoned (or back to in-progress with null).
 * The plan's owner (the coach who added it) only; the plan must be accepted.
 */
export async function setPlanOutcome(
  planId: number,
  coachId: number,
  outcome: "finished" | "abandoned" | null
): Promise<CoachingTemplate | null> {
  const pool = getPool();
  await ensureSchema();
  const plan = await getTemplate(planId);
  if (
    !plan ||
    plan.deleted_at ||
    plan.scope !== "partnership" ||
    !plan.accepted_at ||
    !(await userManagesThreadPlan(planId, coachId))
  ) {
    return null;
  }
  await pool.query(
    "UPDATE coaching_templates SET outcome = $2, updated_at = NOW() WHERE id = $1",
    [planId, outcome]
  );
  return getTemplate(planId);
}

/**
 * Revive a superseded plan: make it the thread's live plan again (fresh/pending),
 * superseding every other plan. Returns the updated plan, or null if not a
 * coach-manageable partnership plan.
 */
export async function reactivateThreadPlan(
  planId: number,
  coachId: number
): Promise<CoachingTemplate | null> {
  const pool = getPool();
  await ensureSchema();
  const plan = await getTemplate(planId);
  if (
    !plan ||
    plan.deleted_at ||
    plan.scope !== "partnership" ||
    plan.thread_id == null ||
    !(await userManagesThreadPlan(planId, coachId))
  ) {
    return null;
  }
  await clearPlanAcceptances(planId);
  await pool.query(
    `UPDATE coaching_templates
        SET deactivated_at = NULL, accepted_at = NULL, current_node_id = NULL,
            outcome = NULL, updated_at = NOW()
      WHERE id = $1`,
    [planId]
  );
  await deactivatePriorThreadPlans(plan.thread_id, planId);
  return getTemplate(planId);
}

/**
 * Whether a user may MANAGE an embedded plan (edit/dismiss/unlock/outcome). Any
 * coach who participates in the plan's thread can — not just the one who added
 * it — so multiple coaches share the same rights over a thread's plans.
 */
export async function userManagesThreadPlan(planId: number, userId: number): Promise<boolean> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    `SELECT 1 FROM coaching_templates ct
       JOIN thread_participants p ON p.thread_id = ct.thread_id AND p.user_id = $2
       JOIN users u ON u.id = p.user_id
      WHERE ct.id = $1 AND ct.scope = 'partnership' AND ct.deleted_at IS NULL
        AND u.system_role = 'coach'
      LIMIT 1`,
    [planId, userId]
  );
  return res.rows.length > 0;
}

// ============================================================
// Activity submissions, coach review, and plan advancement
// ============================================================

export type SubmissionStatus = "pending" | "approved" | "returned";

export interface ActivitySubmission {
  id: number;
  plan_id: number;
  node_id: string;
  phase_id: string | null;
  partner_id: number | null;
  message_id: number | null;
  gating: "OPEN" | "REVIEWED";
  status: SubmissionStatus;
  feedback: string | null;
  created_at: string;
  decided_at: string | null;
  decided_by: number | null;
}

function rowToSubmission(r: Record<string, unknown>): ActivitySubmission {
  return {
    id: r.id as number,
    plan_id: r.plan_id as number,
    node_id: r.node_id as string,
    phase_id: (r.phase_id as string | null) ?? null,
    partner_id: (r.partner_id as number | null) ?? null,
    message_id: (r.message_id as number | null) ?? null,
    gating: (r.gating as "OPEN" | "REVIEWED") ?? "REVIEWED",
    status: (r.status as SubmissionStatus) ?? "pending",
    feedback: (r.feedback as string | null) ?? null,
    created_at: toIso(r.created_at),
    decided_at: r.decided_at ? toIso(r.decided_at) : null,
    decided_by: (r.decided_by as number | null) ?? null,
  };
}

/** The thread's single live plan (accepted, in progress), or null. */
export async function getActivePlanForThread(threadId: number): Promise<CoachingTemplate | null> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    `SELECT * FROM coaching_templates
      WHERE thread_id = $1 AND scope = 'partnership' AND deleted_at IS NULL
        AND accepted_at IS NOT NULL AND outcome IS NULL AND deactivated_at IS NULL
      ORDER BY accepted_at DESC LIMIT 1`,
    [threadId]
  );
  return res.rows[0] ? rowToTemplate(res.rows[0]) : null;
}

/** The current (latest non-superseded) submission for a plan's node, or null. */
export async function getCurrentSubmission(
  planId: number,
  nodeId: string
): Promise<ActivitySubmission | null> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    `SELECT * FROM activity_submissions
      WHERE plan_id = $1 AND node_id = $2
      ORDER BY id DESC LIMIT 1`,
    [planId, nodeId]
  );
  return res.rows[0] ? rowToSubmission(res.rows[0]) : null;
}

export async function getSubmission(id: number): Promise<ActivitySubmission | null> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query("SELECT * FROM activity_submissions WHERE id = $1", [id]);
  return res.rows[0] ? rowToSubmission(res.rows[0]) : null;
}

/** Approved submissions for every node in a phase (history shown to the coach). */
export async function getPhaseApprovedSubmissions(
  planId: number,
  phaseId: string | null
): Promise<ActivitySubmission[]> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    `SELECT * FROM activity_submissions
      WHERE plan_id = $1 AND status = 'approved'
        AND ($2::text IS NULL OR phase_id = $2)
      ORDER BY decided_at ASC, id ASC`,
    [planId, phaseId]
  );
  return res.rows.map(rowToSubmission);
}

/**
 * Mark a chat message as the active activity's submission. Enforces one live
 * submission per (plan, node): a prior pending/returned row is updated in place;
 * an already-approved node is left untouched (returns it). `status` is set by the
 * caller per gating ('approved' for OPEN mid-phase self-attest, else 'pending').
 */
export async function markActivitySubmission(params: {
  planId: number;
  nodeId: string;
  phaseId: string | null;
  partnerId: number;
  messageId: number;
  gating: "OPEN" | "REVIEWED";
  status: SubmissionStatus;
}): Promise<ActivitySubmission | null> {
  const pool = getPool();
  await ensureSchema();
  const existing = await getCurrentSubmission(params.planId, params.nodeId);
  if (existing && existing.status === "approved") return existing;
  if (existing) {
    const res = await pool.query(
      `UPDATE activity_submissions
          SET message_id = $2, partner_id = $3, gating = $4, status = $5,
              feedback = NULL, decided_at = NULL, decided_by = NULL, created_at = NOW()
        WHERE id = $1 RETURNING *`,
      [existing.id, params.messageId, params.partnerId, params.gating, params.status]
    );
    return rowToSubmission(res.rows[0]);
  }
  const res = await pool.query(
    `INSERT INTO activity_submissions
       (plan_id, node_id, phase_id, partner_id, message_id, gating, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      params.planId,
      params.nodeId,
      params.phaseId,
      params.partnerId,
      params.messageId,
      params.gating,
      params.status,
    ]
  );
  return rowToSubmission(res.rows[0]);
}

/** Record a coach's decision on a submission ('approved' or 'returned'). */
export async function decideSubmission(
  submissionId: number,
  coachId: number,
  status: "approved" | "returned",
  feedback?: string | null
): Promise<ActivitySubmission | null> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    `UPDATE activity_submissions
        SET status = $2, feedback = $3, decided_at = NOW(), decided_by = $4
      WHERE id = $1 RETURNING *`,
    [submissionId, status, feedback?.trim() || null, coachId]
  );
  return res.rows[0] ? rowToSubmission(res.rows[0]) : null;
}

/**
 * Advance the plan's current activity to the next node in the flow. If there is
 * no next node, the plan is complete → mark it finished. Returns
 * { nextNodeId, crossedPhase, finished }.
 */
export async function advanceActivity(
  planId: number
): Promise<{ nextNodeId: string | null; crossedPhase: boolean; finished: boolean }> {
  const pool = getPool();
  await ensureSchema();
  const plan = await getTemplate(planId);
  if (!plan || !plan.current_node_id) return { nextNodeId: null, crossedPhase: false, finished: false };
  const next = nextNodeId(plan.graph, plan.current_node_id);
  if (next == null) {
    await pool.query(
      "UPDATE coaching_templates SET outcome = 'finished', current_node_id = NULL, updated_at = NOW() WHERE id = $1",
      [planId]
    );
    return { nextNodeId: null, crossedPhase: false, finished: true };
  }
  const crossedPhase =
    phaseIdOfNode(plan.graph, plan.current_node_id) !== phaseIdOfNode(plan.graph, next);
  await pool.query(
    "UPDATE coaching_templates SET current_node_id = $2, updated_at = NOW() WHERE id = $1",
    [planId, next]
  );
  return { nextNodeId: next, crossedPhase, finished: false };
}

/** Whether the plan's current activity is the last one in its phase. */
export async function currentIsLastInPhase(planId: number): Promise<boolean> {
  const plan = await getTemplate(planId);
  if (!plan || !plan.current_node_id) return false;
  return isLastInPhase(plan.graph, plan.current_node_id);
}

export interface ConsultTurn {
  id: number;
  role: "coach" | "dewey";
  body: string;
  created_at: string;
}

export async function addConsultTurn(
  submissionId: number,
  role: "coach" | "dewey",
  body: string
): Promise<void> {
  const pool = getPool();
  await ensureSchema();
  await pool.query(
    "INSERT INTO activity_review_consults (submission_id, role, body) VALUES ($1, $2, $3)",
    [submissionId, role, body]
  );
}

export async function getConsultTurns(submissionId: number): Promise<ConsultTurn[]> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    "SELECT id, role, body, created_at FROM activity_review_consults WHERE submission_id = $1 ORDER BY id ASC",
    [submissionId]
  );
  return res.rows.map((r) => ({
    id: r.id as number,
    role: r.role as "coach" | "dewey",
    body: r.body as string,
    created_at: toIso(r.created_at),
  }));
}

/** Remove all acceptances for a plan (e.g. on edit/revise/unlock). */
export async function clearPlanAcceptances(planId: number): Promise<void> {
  const pool = getPool();
  await ensureSchema();
  await pool.query("DELETE FROM plan_acceptances WHERE plan_id = $1", [planId]);
}

/** The user ids who have accepted each of the given plans. */
export async function getPlanAcceptances(planIds: number[]): Promise<Map<number, number[]>> {
  const map = new Map<number, number[]>();
  if (planIds.length === 0) return map;
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    "SELECT plan_id, user_id FROM plan_acceptances WHERE plan_id = ANY($1::int[])",
    [planIds]
  );
  for (const r of res.rows) {
    const list = map.get(r.plan_id as number) ?? [];
    list.push(r.user_id as number);
    map.set(r.plan_id as number, list);
  }
  return map;
}

/**
 * Record one participant's acceptance of an embedded plan. When EVERY thread
 * participant has accepted, the plan locks in (accepted_at + current activity
 * set, other plans superseded). Returns { locked } or null if the plan isn't
 * acceptable (deleted/superseded/already locked) or the user isn't a participant.
 */
export async function recordPlanAcceptance(
  planId: number,
  userId: number
): Promise<{ locked: boolean } | null> {
  const pool = getPool();
  await ensureSchema();
  const plan = await getTemplate(planId);
  if (
    !plan ||
    plan.deleted_at ||
    plan.scope !== "partnership" ||
    plan.deactivated_at ||
    plan.accepted_at ||
    plan.thread_id == null
  ) {
    return null;
  }
  const part = await pool.query(
    "SELECT 1 FROM thread_participants WHERE thread_id = $1 AND user_id = $2",
    [plan.thread_id, userId]
  );
  if (!part.rows[0]) return null;
  await pool.query(
    "INSERT INTO plan_acceptances (plan_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [planId, userId]
  );
  const counts = await pool.query(
    `SELECT (SELECT COUNT(*) FROM thread_participants WHERE thread_id = $1) AS total,
            (SELECT COUNT(*) FROM plan_acceptances WHERE plan_id = $2) AS accepted`,
    [plan.thread_id, planId]
  );
  const total = Number(counts.rows[0].total);
  const accepted = Number(counts.rows[0].accepted);
  if (total > 0 && accepted >= total) {
    const current = entryNodeId(plan.graph);
    await deactivatePriorThreadPlans(plan.thread_id, planId);
    await pool.query(
      `UPDATE coaching_templates
          SET accepted_at = NOW(), current_node_id = $2, deactivated_at = NULL, updated_at = NOW()
        WHERE id = $1`,
      [planId, current]
    );
    return { locked: true };
  }
  return { locked: false };
}

/**
 * Unlock a fully-accepted plan so its owner can edit/dismiss/replace it again.
 * RESTARTS it: clears acceptances + the current-activity pointer. Returns the
 * updated plan, or null if it isn't an accepted plan owned by this coach.
 */
export async function unlockPartnershipPlan(
  planId: number,
  coachId: number
): Promise<CoachingTemplate | null> {
  const pool = getPool();
  await ensureSchema();
  const plan = await getTemplate(planId);
  if (
    !plan ||
    plan.deleted_at ||
    plan.scope !== "partnership" ||
    !plan.accepted_at ||
    !(await userManagesThreadPlan(planId, coachId))
  ) {
    return null;
  }
  await clearPlanAcceptances(planId);
  await pool.query(
    `UPDATE coaching_templates
        SET accepted_at = NULL, current_node_id = NULL, updated_at = NOW()
      WHERE id = $1`,
    [planId]
  );
  return getTemplate(planId);
}

/**
 * Revise an embedded plan in place (e.g. @dewey adjusting it on request).
 * Replaces the graph and resets acceptance (clears all acceptances) so everyone
 * re-accepts the revised plan. Returns the updated plan, or null if not owned by
 * this coach — or if it's already locked in (fully accepted).
 */
export async function revisePartnershipPlan(
  planId: number,
  coachId: number,
  graph: TemplateGraph
): Promise<CoachingTemplate | null> {
  const pool = getPool();
  await ensureSchema();
  const plan = await getTemplate(planId);
  if (
    !plan ||
    plan.deleted_at ||
    plan.scope !== "partnership" ||
    plan.accepted_at || // locked plans can't be revised
    !(await userManagesThreadPlan(planId, coachId))
  ) {
    return null;
  }
  await clearPlanAcceptances(planId);
  await pool.query(
    `UPDATE coaching_templates
        SET graph = $2, accepted_at = NULL, current_node_id = NULL,
            deactivated_at = NULL, updated_at = NOW()
      WHERE id = $1`,
    [planId, JSON.stringify(graph)]
  );
  // A revised plan supersedes any earlier plan in the thread.
  if (plan.thread_id != null) await deactivatePriorThreadPlans(plan.thread_id, planId);
  return getTemplate(planId);
}

/** Update a coach's own personal template only. Returns null if not owned. */
export async function updateCoachTemplate(
  id: number,
  coachId: number,
  params: { name?: string; description?: string | null; graph?: TemplateGraph }
): Promise<CoachingTemplate | null> {
  const owned = await getTemplate(id);
  if (!owned || owned.deleted_at || owned.scope === "global") return null;
  if (owned.scope === "partnership") {
    // Any coach in the thread can edit an embedded plan — except a locked one.
    if (owned.accepted_at) return null;
    if (!(await userManagesThreadPlan(id, coachId))) return null;
    // Editing a not-yet-locked plan resets acceptances — everyone re-accepts.
    if (params.graph !== undefined) await clearPlanAcceptances(id);
  } else if (owned.owner_id !== coachId) {
    return null; // a coach's own personal plan only
  }
  return updateTemplate(id, params);
}

/** Soft-delete a coach's own personal template only. */
export async function deleteCoachTemplate(id: number, coachId: number): Promise<boolean> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    `UPDATE coaching_templates SET deleted_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND scope = 'personal' AND owner_id = $2 AND deleted_at IS NULL`,
    [id, coachId]
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Duplicate any template the coach can see (a global one or their own) into a
 * new personal, editable copy owned by the coach. Returns null if the source
 * isn't visible to them.
 */
export async function duplicateTemplateForCoach(
  sourceId: number,
  coachId: number
): Promise<CoachingTemplate | null> {
  let source = await getTemplateForCoach(sourceId, coachId);
  // Also allow copying an embedded thread plan the coach co-manages (any state:
  // active, superseded, finished, or abandoned).
  if (!source) {
    const t = await getTemplate(sourceId);
    if (t && !t.deleted_at && t.scope === "partnership" && (await userManagesThreadPlan(sourceId, coachId))) {
      source = t;
    }
  }
  if (!source) return null;
  return createTemplate({
    name: `${source.name} (copy)`,
    description: source.description,
    graph: source.graph,
    createdBy: coachId,
    scope: "personal",
    ownerId: coachId,
  });
}

export async function updateTemplate(
  id: number,
  params: { name?: string; description?: string | null; graph?: TemplateGraph }
): Promise<CoachingTemplate | null> {
  const pool = getPool();
  await ensureSchema();
  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  if (params.name !== undefined) {
    sets.push(`name = $${i++}`);
    values.push(params.name.trim());
  }
  if (params.description !== undefined) {
    sets.push(`description = $${i++}`);
    values.push(params.description?.trim() || null);
  }
  if (params.graph !== undefined) {
    sets.push(`graph = $${i++}`);
    values.push(JSON.stringify(params.graph));
  }
  if (sets.length === 0) return getTemplate(id);
  sets.push("updated_at = NOW()");
  values.push(id);
  const res = await pool.query(
    `UPDATE coaching_templates SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
    values
  );
  return res.rows[0] ? rowToTemplate(res.rows[0]) : null;
}

/** Soft-delete any template (admin). */
export async function deleteTemplate(id: number): Promise<boolean> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    "UPDATE coaching_templates SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1 AND deleted_at IS NULL",
    [id]
  );
  return (res.rowCount ?? 0) > 0;
}

export async function restoreTemplate(id: number): Promise<boolean> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    "UPDATE coaching_templates SET deleted_at = NULL, updated_at = NOW() WHERE id = $1",
    [id]
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Publish a coach's personal template as a global one (admin approval of a
 * district-wide submission). owner_id is kept as provenance. Returns the updated
 * template, or null if it isn't a live personal template.
 */
export async function publishTemplateAsGlobal(id: number): Promise<CoachingTemplate | null> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    `UPDATE coaching_templates SET scope = 'global', updated_at = NOW()
      WHERE id = $1 AND scope = 'personal' AND deleted_at IS NULL
      RETURNING *`,
    [id]
  );
  return res.rows[0] ? rowToTemplate(res.rows[0]) : null;
}

/** Persist a user's theme choice in their settings JSONB (overrides the admin default). */
export async function setUserTheme(userId: number, theme: "light" | "dark"): Promise<void> {
  const pool = getPool();
  await ensureSchema();
  await pool.query(
    `UPDATE users
        SET settings = jsonb_set(settings, '{theme}', to_jsonb($2::text), true),
            updated_at = NOW()
      WHERE id = $1`,
    [userId, theme]
  );
}

// ============================================================
// User audit log
// ============================================================

/** A loggable entity the UI can deep-link to. */
export type LogEntityType = "template" | "message" | "user" | "district" | "school";

export interface UserLog {
  id: number;
  action: string;
  detail: string | null;
  created_at: string;
  actor_id: number | null;
  actor_name: string | null;
  entity_type: LogEntityType | null;
  entity_id: number | null;
  entity_label: string | null;
}

/**
 * Append an audit entry for a user. Best-effort: a logging failure is recorded
 * to the console but never propagates, so it can't break the primary action.
 * `userId` is the subject (whose log it appears in); for an actor's own actions
 * (e.g. an admin editing a template) subject and actor are the same.
 */
export async function logUserEvent(params: {
  userId: number;
  actorId?: number | null;
  action: string;
  detail?: string | null;
  entityType?: LogEntityType | null;
  entityId?: number | null;
  entityLabel?: string | null;
}): Promise<void> {
  try {
    const pool = getPool();
    await ensureSchema();
    await pool.query(
      `INSERT INTO user_logs (user_id, actor_id, action, detail, entity_type, entity_id, entity_label)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        params.userId,
        params.actorId ?? null,
        params.action,
        params.detail ?? null,
        params.entityType ?? null,
        params.entityId ?? null,
        params.entityLabel ?? null,
      ]
    );
  } catch (e) {
    console.error("[logUserEvent]", e);
  }
}

/**
 * Audit-log entries for a user, newest first. An optional `q` narrows results
 * server-side (case-insensitive across action, detail, and entity label) so the
 * full-log view can filter live as the admin types.
 */
export async function getUserLogs(
  userId: number,
  opts: { limit?: number; q?: string } = {}
): Promise<UserLog[]> {
  const pool = getPool();
  await ensureSchema();
  const limit = opts.limit ?? 50;
  const q = opts.q?.trim();

  const params: unknown[] = [userId];
  let where = "l.user_id = $1";
  if (q) {
    params.push(`%${q}%`);
    where += ` AND (l.action ILIKE $2 OR l.detail ILIKE $2 OR l.entity_label ILIKE $2)`;
  }
  params.push(limit);

  const res = await pool.query(
    `SELECT l.id, l.action, l.detail, l.created_at, l.actor_id, a.full_name AS actor_name,
            l.entity_type, l.entity_id, l.entity_label
       FROM user_logs l
       LEFT JOIN users a ON a.id = l.actor_id
      WHERE ${where}
      ORDER BY l.created_at DESC
      LIMIT $${params.length}`,
    params
  );
  return res.rows.map((r) => ({
    id: Number(r.id),
    action: r.action as string,
    detail: (r.detail as string | null) ?? null,
    created_at: toIso(r.created_at),
    actor_id: (r.actor_id as number | null) ?? null,
    actor_name: (r.actor_name as string | null) ?? null,
    entity_type: (r.entity_type as LogEntityType | null) ?? null,
    entity_id: (r.entity_id as number | null) ?? null,
    entity_label: (r.entity_label as string | null) ?? null,
  }));
}

// ============================================================
// Setup + seed
// ============================================================

/**
 * Create the very first admin account. Guards against a second admin so the
 * setup route is idempotent against double-submit / browser-back. Also inserts
 * the singleton system_settings row, then seeds the demo accounts.
 */
export async function createInitialAdmin(params: {
  username: string;
  password: string;
  full_name: string;
  nickname?: string | null;
  email?: string | null;
}): Promise<User> {
  if (await hasAdmin()) {
    throw new Error("An admin account already exists");
  }
  const admin = await createUser({
    username: params.username,
    password: params.password,
    full_name: params.full_name,
    nickname: params.nickname ?? null,
    email: params.email ?? null,
    system_role: "admin",
  });
  await ensureSystemSettingsRow();
  await createDemoUsers();
  return admin;
}

/** Insert the single system_settings row with defaults if it doesn't exist. */
export async function ensureSystemSettingsRow(): Promise<void> {
  const pool = getPool();
  await ensureSchema();
  await pool.query(
    `INSERT INTO system_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`
  );
}

/**
 * Seed the Erewhon district / Atlantis school and the jcoach + jpartner demo
 * accounts. Idempotent: skips anything that already exists. Passwords are
 * hashed at runtime (the seed.sql file documents intent only).
 */
export async function createDemoUsers(): Promise<void> {
  const pool = getPool();
  await ensureSchema();

  // District
  let district = (await getDistricts()).find((d) => d.name === "Erewhon School District");
  if (!district) district = await createDistrict("Erewhon School District");

  // School
  let school = (await getSchools(district.id)).find(
    (s) => s.name === "Atlantis Elementary School"
  );
  if (!school) school = await createSchool(district.id, "Atlantis Elementary School");

  const demos: CreateUserParams[] = [
    {
      username: "jcoach",
      password: "jcoach",
      full_name: "John Coach",
      nickname: "John",
      system_role: "coach",
      district_id: district.id,
      school_id: school.id,
      role: "Instructional Literacy Coach",
      about: "",
    },
    {
      username: "jpartner",
      password: "jpartner",
      full_name: "Jane Partner",
      nickname: "Jane",
      system_role: "partner",
      district_id: district.id,
      school_id: school.id,
      role: "3rd Grade Teacher",
      about: "",
    },
  ];

  for (const demo of demos) {
    const exists = await getUserWithHashByUsername(demo.username);
    if (!exists) {
      await createUser(demo);
      continue;
    }
    // Backfill the building assignment for accounts seeded before multi-building,
    // so demo users (e.g. jcoach) reliably land in Atlantis Elementary School.
    const current = await getUserById(exists.id);
    if (current && current.school_ids.length === 0 && demo.school_id != null) {
      await setUserSchools(exists.id, [demo.school_id]);
    }
  }
}
