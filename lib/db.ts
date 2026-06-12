import { getPool } from "@/lib/pg";
import { hashPassword } from "@/lib/password";
import type { CoachingTemplate, TemplateGraph, TemplateScope } from "@/lib/templates";
import { EMPTY_GRAPH } from "@/lib/templates";

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
  school_id: number | null;
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
  const res = await pool.query("SELECT id, name, created_at FROM districts ORDER BY name");
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

export async function deleteDistrict(id: number): Promise<boolean> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query("DELETE FROM districts WHERE id = $1", [id]);
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
        "SELECT id, district_id, name, created_at FROM schools WHERE district_id = $1 ORDER BY name",
        [districtId]
      )
    : await pool.query("SELECT id, district_id, name, created_at FROM schools ORDER BY name");
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

export async function deleteSchool(id: number): Promise<boolean> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query("DELETE FROM schools WHERE id = $1", [id]);
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
    "SELECT COUNT(*)::int AS n FROM users WHERE system_role = 'admin'"
  );
  return res.rows[0]?.n ?? 0;
}

export async function hasAdmin(): Promise<boolean> {
  return (await getAdminCount()) > 0;
}

export async function getAllUsers(): Promise<User[]> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(`SELECT ${USER_COLUMNS} FROM users ORDER BY id`);
  return res.rows.map(rowToUser);
}

export async function getUserById(id: number): Promise<User | null> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1 LIMIT 1`, [id]);
  return res.rows[0] ? rowToUser(res.rows[0]) : null;
}

/** Includes password_hash — for auth only. Never expose this shape to clients. */
export async function getUserWithHashByUsername(
  username: string
): Promise<(User & { password_hash: string }) | null> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    `SELECT ${USER_COLUMNS}, password_hash FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1`,
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
  role?: string | null;
  about?: string | null;
}

export async function createUser(params: CreateUserParams): Promise<User> {
  const pool = getPool();
  await ensureSchema();
  const username = params.username.trim();
  if (!username) throw new Error("Username is required");
  if (!params.full_name?.trim()) throw new Error("Full name is required");
  const existing = await getUserWithHashByUsername(username);
  if (existing) throw new Error("Username already taken");
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
  return rowToUser(res.rows[0]);
}

export interface UpdateUserParams {
  full_name?: string;
  nickname?: string | null;
  email?: string | null;
  system_role?: SystemRole;
  district_id?: number | null;
  school_id?: number | null;
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
  if (params.school_id !== undefined) push("school_id", params.school_id);
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

  if (sets.length === 0) {
    const current = await getUserById(id);
    if (!current) throw new Error("User not found");
    return current;
  }

  sets.push("updated_at = NOW()");
  values.push(id);
  const res = await pool.query(
    `UPDATE users SET ${sets.join(", ")} WHERE id = $${i} RETURNING ${USER_COLUMNS}`,
    values
  );
  if (!res.rows[0]) throw new Error("User not found");
  return rowToUser(res.rows[0]);
}

export async function deleteUser(id: number): Promise<boolean> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query("DELETE FROM users WHERE id = $1", [id]);
  return (res.rowCount ?? 0) > 0;
}

// ============================================================
// Coach partner directory
// ============================================================

export interface DirectoryPartner extends User {
  district_name: string | null;
  school_name: string | null;
}

/**
 * Partners visible to a coach. A school-assigned coach sees partners in their
 * school; a district-wide coach (no school) sees every partner in the district.
 * Returns the partners (with district/school names) plus the schools in the
 * coach's district for the directory's school filter, and the directory scope.
 */
export async function getCoachDirectory(coach: {
  district_id: number | null;
  school_id: number | null;
}): Promise<{
  partners: DirectoryPartner[];
  schools: School[];
  scope: "school" | "district" | "none";
}> {
  const pool = getPool();
  await ensureSchema();

  if (coach.district_id == null) {
    return { partners: [], schools: [], scope: "none" };
  }

  const scope: "school" | "district" = coach.school_id != null ? "school" : "district";
  const params: unknown[] = [coach.district_id];
  let where = "u.system_role = 'partner' AND u.district_id = $1";
  if (scope === "school") {
    params.push(coach.school_id);
    where += " AND u.school_id = $2";
  }

  const res = await pool.query(
    `SELECT ${USER_COLUMNS.split(", ").map((c) => `u.${c}`).join(", ")},
            d.name AS district_name, s.name AS school_name
       FROM users u
       LEFT JOIN districts d ON d.id = u.district_id
       LEFT JOIN schools s ON s.id = u.school_id
      WHERE ${where}
      ORDER BY u.full_name`,
    params
  );

  const partners: DirectoryPartner[] = res.rows.map((r) => ({
    ...rowToUser(r),
    district_name: (r.district_name as string | null) ?? null,
    school_name: (r.school_name as string | null) ?? null,
  }));

  const schools = await getSchools(coach.district_id);
  return { partners, schools, scope };
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
    scope: ((row.scope as string) === "personal" ? "personal" : "global") as TemplateScope,
    owner_id: (row.owner_id as number | null) ?? null,
    created_by: (row.created_by as number | null) ?? null,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

/** Admin-facing list: the global templates available to every coach. */
export async function getTemplates(): Promise<CoachingTemplate[]> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    "SELECT * FROM coaching_templates WHERE scope = 'global' ORDER BY name"
  );
  return res.rows.map(rowToTemplate);
}

/** Coach-facing list: every global template plus the coach's own personal ones. */
export async function getTemplatesForCoach(coachId: number): Promise<CoachingTemplate[]> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    `SELECT * FROM coaching_templates
      WHERE scope = 'global' OR owner_id = $1
      ORDER BY scope = 'global' DESC, name`,
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
  if (!t) return null;
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
}): Promise<CoachingTemplate> {
  const pool = getPool();
  await ensureSchema();
  const scope: TemplateScope = params.scope ?? "global";
  const res = await pool.query(
    `INSERT INTO coaching_templates (name, description, graph, created_by, scope, owner_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [
      params.name.trim(),
      params.description?.trim() || null,
      JSON.stringify(params.graph ?? EMPTY_GRAPH),
      params.createdBy ?? null,
      scope,
      scope === "personal" ? params.ownerId ?? null : null,
    ]
  );
  return rowToTemplate(res.rows[0]);
}

/** Update a coach's own personal template only. Returns null if not owned. */
export async function updateCoachTemplate(
  id: number,
  coachId: number,
  params: { name?: string; description?: string | null; graph?: TemplateGraph }
): Promise<CoachingTemplate | null> {
  const owned = await getTemplate(id);
  if (!owned || owned.scope !== "personal" || owned.owner_id !== coachId) return null;
  return updateTemplate(id, params);
}

/** Delete a coach's own personal template only. */
export async function deleteCoachTemplate(id: number, coachId: number): Promise<boolean> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query(
    `DELETE FROM coaching_templates
      WHERE id = $1 AND scope = 'personal' AND owner_id = $2`,
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
  const source = await getTemplateForCoach(sourceId, coachId);
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

export async function deleteTemplate(id: number): Promise<boolean> {
  const pool = getPool();
  await ensureSchema();
  const res = await pool.query("DELETE FROM coaching_templates WHERE id = $1", [id]);
  return (res.rowCount ?? 0) > 0;
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
    if (!exists) await createUser(demo);
  }
}
