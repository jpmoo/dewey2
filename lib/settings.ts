import { getPool } from "@/lib/pg";
import { ensureSchema, ensureSystemSettingsRow } from "@/lib/db";

/**
 * The singleton system_settings row (id = 1). Holds global configuration:
 * the Ollama connection + selected models, the Anthropic key, RAG config, and
 * the default theme. Updated in place; never inserted twice.
 */
/** Which scopes a role may message, per target role. */
export interface RoleMessagePerms {
  partner_same_school: boolean;
  partner_district: boolean;
  coach_same_school: boolean;
  coach_district: boolean;
}
export interface MessagePermissions {
  coach: RoleMessagePerms;
  partner: RoleMessagePerms;
}

export const DEFAULT_MESSAGE_PERMISSIONS: MessagePermissions = {
  coach: {
    partner_same_school: true,
    partner_district: false,
    coach_same_school: true,
    coach_district: true,
  },
  partner: {
    partner_same_school: false,
    partner_district: false,
    coach_same_school: true,
    coach_district: false,
  },
};

function coercePerms(v: unknown): MessagePermissions {
  const role = (r: unknown, d: RoleMessagePerms): RoleMessagePerms => {
    const o = (r ?? {}) as Record<string, unknown>;
    return {
      partner_same_school: o.partner_same_school === true,
      partner_district: o.partner_district === true,
      coach_same_school: o.coach_same_school === true,
      coach_district: o.coach_district === true,
    };
  };
  const obj = (v ?? {}) as Record<string, unknown>;
  return {
    coach: role(obj.coach, DEFAULT_MESSAGE_PERMISSIONS.coach),
    partner: role(obj.partner, DEFAULT_MESSAGE_PERMISSIONS.partner),
  };
}

export interface SystemSettings {
  ollama_url: string | null;
  ollama_compliance_model: string | null;
  ollama_coaching_model: string | null;
  /** Context-window ceiling for Ollama (num_ctx). 0/null = each model's full window. */
  ollama_num_ctx: number;
  anthropic_api_key: string | null;
  rag_url: string | null;
  rag_default_threshold: number;
  /** Collections selected as the platform-wide default for retrieval. */
  rag_default_collections: string[];
  default_theme: string;
  message_permissions: MessagePermissions;
  settings: Record<string, unknown>;
  updated_at: string;
}

function rowToSettings(row: Record<string, unknown>): SystemSettings {
  return {
    ollama_url: (row.ollama_url as string | null) ?? null,
    ollama_compliance_model: (row.ollama_compliance_model as string | null) ?? null,
    ollama_coaching_model: (row.ollama_coaching_model as string | null) ?? null,
    ollama_num_ctx: row.ollama_num_ctx != null ? Number(row.ollama_num_ctx) : 0,
    anthropic_api_key: (row.anthropic_api_key as string | null) ?? null,
    rag_url: (row.rag_url as string | null) ?? null,
    rag_default_threshold:
      row.rag_default_threshold != null ? Number(row.rag_default_threshold) : 0.5,
    rag_default_collections: Array.isArray(row.rag_default_collections)
      ? (row.rag_default_collections as string[])
      : [],
    default_theme: (row.default_theme as string | null) ?? "light",
    message_permissions: coercePerms(row.message_permissions),
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
  ollama_num_ctx?: number;
  anthropic_api_key?: string | null;
  rag_url?: string | null;
  rag_default_threshold?: number;
  rag_default_collections?: string[];
  default_theme?: string;
  message_permissions?: MessagePermissions;
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
  if (params.ollama_num_ctx !== undefined)
    push("ollama_num_ctx", params.ollama_num_ctx > 0 ? Math.floor(params.ollama_num_ctx) : null);
  if (params.anthropic_api_key !== undefined)
    push("anthropic_api_key", emptyToNull(params.anthropic_api_key));
  if (params.rag_url !== undefined) push("rag_url", emptyToNull(params.rag_url));
  if (params.rag_default_threshold !== undefined)
    push("rag_default_threshold", params.rag_default_threshold);
  if (params.rag_default_collections !== undefined)
    push("rag_default_collections", JSON.stringify(params.rag_default_collections));
  if (params.default_theme !== undefined) push("default_theme", params.default_theme);
  if (params.message_permissions !== undefined)
    push("message_permissions", JSON.stringify(params.message_permissions));
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
