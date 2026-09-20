import { getPool } from "@/lib/pg";
import { ensureSchema, ensureSystemSettingsRow } from "@/lib/db";

/**
 * The singleton system_settings row (id = 1). Holds global configuration:
 * the Ollama connection + selected models, the Anthropic key, RAG config, and
 * the default theme. Updated in place; never inserted twice.
 */
/**
 * How far a sender role may reach a given target role: not at all, only within a
 * shared building, or anywhere in the district. Admins are always reachable and
 * can always message anyone, so they're not part of this matrix.
 */
export type MessageReach = "none" | "school" | "district";

/** The non-admin roles that participate in the messaging matrix (as sender + target). */
export const MESSAGE_ROLES = [
  "coach",
  "district_leader",
  "site_leader",
  "deputy_site_leader",
  "partner",
] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

/** sender role → target role → reach. */
export type MessagePermissions = Record<string, Record<string, MessageReach>>;

export const DEFAULT_MESSAGE_PERMISSIONS: MessagePermissions = {
  // Coaches and district leaders can reach anyone in their district.
  coach: { coach: "district", district_leader: "district", site_leader: "district", deputy_site_leader: "district", partner: "district" },
  district_leader: { coach: "district", district_leader: "district", site_leader: "district", deputy_site_leader: "district", partner: "district" },
  // Site/deputy leaders reach staff and leaders district-wide, and partners in their building.
  site_leader: { coach: "district", district_leader: "district", site_leader: "district", deputy_site_leader: "district", partner: "school" },
  deputy_site_leader: { coach: "district", district_leader: "district", site_leader: "district", deputy_site_leader: "district", partner: "school" },
  // Partners can start with a coach or a site/deputy leader in their building.
  partner: { coach: "school", district_leader: "none", site_leader: "school", deputy_site_leader: "school", partner: "none" },
};

function coerceReach(v: unknown): MessageReach {
  return v === "school" || v === "district" ? v : "none";
}

function coercePerms(v: unknown): MessagePermissions {
  const obj = (v ?? {}) as Record<string, Record<string, unknown>>;
  const out: MessagePermissions = {};
  for (const sender of MESSAGE_ROLES) {
    const row = (obj[sender] ?? {}) as Record<string, unknown>;
    const def = DEFAULT_MESSAGE_PERMISSIONS[sender];
    // A row is "new-shape" only if it carries at least one target-role key; older
    // stored data used a different shape, so fall back to defaults for that role.
    const isNewShape = MESSAGE_ROLES.some((t) => t in row);
    out[sender] = {};
    for (const target of MESSAGE_ROLES) {
      out[sender][target] = isNewShape ? coerceReach(row[target]) : def[target];
    }
  }
  return out;
}

/** Whether a role may create a CoP anchored to a school and/or a district. */
export interface CopCreatePerms {
  school: boolean;
  district: boolean;
}
/** Per-role CoP creation permissions (admins always may; not listed here). */
export type CopCreatePermissions = Record<string, CopCreatePerms>;

/** Non-admin roles that can be granted CoP creation. */
export const COP_CREATOR_ROLES = [
  "coach",
  "district_leader",
  "site_leader",
  "deputy_site_leader",
  "partner",
] as const;

export const DEFAULT_COP_CREATE_PERMISSIONS: CopCreatePermissions = {
  coach: { school: true, district: true },
  district_leader: { school: true, district: true },
  site_leader: { school: false, district: false },
  deputy_site_leader: { school: false, district: false },
  partner: { school: false, district: false },
};

function coerceCopPerms(v: unknown): CopCreatePermissions {
  const obj = (v ?? {}) as Record<string, unknown>;
  const out: CopCreatePermissions = {};
  for (const role of COP_CREATOR_ROLES) {
    const r = (obj[role] ?? {}) as Record<string, unknown>;
    const d = DEFAULT_COP_CREATE_PERMISSIONS[role];
    out[role] = {
      school: role in obj ? r.school === true : d.school,
      district: role in obj ? r.district === true : d.district,
    };
  }
  return out;
}

/** The anchor levels a role may create a CoP at (admins always may both). */
export function copCreateLevels(
  role: string,
  perms: CopCreatePermissions
): CopCreatePerms {
  if (role === "admin") return { school: true, district: true };
  return perms[role] ?? { school: false, district: false };
}

export interface SystemSettings {
  ollama_url: string | null;
  ollama_compliance_model: string | null;
  ollama_coaching_model: string | null;
  /** Ollama model used to embed RAG documents + queries (e.g. nomic-embed-text). */
  ollama_embedding_model: string | null;
  /** Ollama vision model used to describe charts/figures during ingest (v1). */
  ollama_vision_model: string | null;
  /**
   * Model used for background ingest text tasks (e.g. auto-drafting a document
   * description). Defaults to the coaching model when unset. Prefer a local
   * "ollama:<name>" here so ingest stays offline and free.
   */
  ollama_ingest_model: string | null;
  /** Contextual Retrieval: write a situating header per chunk before embedding. */
  rag_contextual_retrieval: boolean;
  /** Context-window ceiling for Ollama (num_ctx). 0/null = each model's full window. */
  ollama_num_ctx: number;
  anthropic_api_key: string | null;
  rag_default_threshold: number;
  default_theme: string;
  message_permissions: MessagePermissions;
  /** Which non-admin roles may create school- / district-anchored CoPs. */
  cop_create_permissions: CopCreatePermissions;
  /** How many days of daily DB/file backups to keep on the server. */
  backup_retention_days: number;
  settings: Record<string, unknown>;
  updated_at: string;
}

function rowToSettings(row: Record<string, unknown>): SystemSettings {
  return {
    ollama_url: (row.ollama_url as string | null) ?? null,
    ollama_compliance_model: (row.ollama_compliance_model as string | null) ?? null,
    ollama_coaching_model: (row.ollama_coaching_model as string | null) ?? null,
    ollama_embedding_model: (row.ollama_embedding_model as string | null) ?? null,
    ollama_vision_model: (row.ollama_vision_model as string | null) ?? null,
    ollama_ingest_model: (row.ollama_ingest_model as string | null) ?? null,
    rag_contextual_retrieval: row.rag_contextual_retrieval !== false,
    ollama_num_ctx: row.ollama_num_ctx != null ? Number(row.ollama_num_ctx) : 0,
    anthropic_api_key: (row.anthropic_api_key as string | null) ?? null,
    rag_default_threshold:
      row.rag_default_threshold != null ? Number(row.rag_default_threshold) : 0.5,
    default_theme: (row.default_theme as string | null) ?? "light",
    message_permissions: coercePerms(row.message_permissions),
    cop_create_permissions: coerceCopPerms(row.cop_create_permissions),
    backup_retention_days:
      row.backup_retention_days != null ? Number(row.backup_retention_days) : 30,
    settings: (row.settings as Record<string, unknown>) ?? {},
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}

export async function getSystemSettings(): Promise<SystemSettings> {
  const pool = getPool();
  await ensureSchema();
  await ensureSystemSettingsRow();
  const res = await pool.query("SELECT * FROM system_settings WHERE id = 1 LIMIT 1");
  return rowToSettings(res.rows[0]);
}

/**
 * The effective Anthropic key. The environment variable wins over the stored
 * value (docs/database.md: "stored here or via env var"), so a deployment can
 * keep the secret out of the database entirely.
 */
export function getEffectiveAnthropicKey(stored: string | null): string | null {
  const fromEnv = process.env.ANTHROPIC_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  return stored?.trim() || null;
}

export interface UpdateSystemSettingsParams {
  ollama_url?: string | null;
  ollama_compliance_model?: string | null;
  ollama_coaching_model?: string | null;
  ollama_embedding_model?: string | null;
  ollama_vision_model?: string | null;
  ollama_ingest_model?: string | null;
  rag_contextual_retrieval?: boolean;
  ollama_num_ctx?: number;
  anthropic_api_key?: string | null;
  rag_default_threshold?: number;
  default_theme?: string;
  message_permissions?: MessagePermissions;
  cop_create_permissions?: CopCreatePermissions;
  backup_retention_days?: number;
  settings?: Record<string, unknown>;
}

export async function updateSystemSettings(
  params: UpdateSystemSettingsParams
): Promise<SystemSettings> {
  const pool = getPool();
  await ensureSchema();
  await ensureSystemSettingsRow();

  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  const push = (col: string, val: unknown) => {
    sets.push(`${col} = $${i++}`);
    values.push(val);
  };

  if (params.ollama_url !== undefined) push("ollama_url", emptyToNull(params.ollama_url));
  if (params.ollama_compliance_model !== undefined)
    push("ollama_compliance_model", emptyToNull(params.ollama_compliance_model));
  if (params.ollama_coaching_model !== undefined)
    push("ollama_coaching_model", emptyToNull(params.ollama_coaching_model));
  if (params.ollama_embedding_model !== undefined)
    push("ollama_embedding_model", emptyToNull(params.ollama_embedding_model));
  if (params.ollama_vision_model !== undefined)
    push("ollama_vision_model", emptyToNull(params.ollama_vision_model));
  if (params.ollama_ingest_model !== undefined)
    push("ollama_ingest_model", emptyToNull(params.ollama_ingest_model));
  if (params.rag_contextual_retrieval !== undefined)
    push("rag_contextual_retrieval", params.rag_contextual_retrieval);
  if (params.ollama_num_ctx !== undefined)
    push("ollama_num_ctx", params.ollama_num_ctx > 0 ? Math.floor(params.ollama_num_ctx) : null);
  if (params.backup_retention_days !== undefined)
    push("backup_retention_days", Math.max(1, Math.floor(params.backup_retention_days || 30)));
  if (params.anthropic_api_key !== undefined)
    push("anthropic_api_key", emptyToNull(params.anthropic_api_key));
  if (params.rag_default_threshold !== undefined)
    push("rag_default_threshold", params.rag_default_threshold);
  if (params.default_theme !== undefined) push("default_theme", params.default_theme);
  if (params.message_permissions !== undefined)
    push("message_permissions", JSON.stringify(coercePerms(params.message_permissions)));
  if (params.cop_create_permissions !== undefined)
    push("cop_create_permissions", JSON.stringify(coerceCopPerms(params.cop_create_permissions)));
  if (params.settings !== undefined) push("settings", JSON.stringify(params.settings));

  if (sets.length === 0) return getSystemSettings();

  sets.push("updated_at = NOW()");
  await pool.query(`UPDATE system_settings SET ${sets.join(", ")} WHERE id = 1`, values);
  return getSystemSettings();
}

function emptyToNull(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t === "" ? null : t;
}
