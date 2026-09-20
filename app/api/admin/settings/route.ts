import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";
import { logUserEvent } from "@/lib/db";
import {
  getSystemSettings,
  updateSystemSettings,
  getEffectiveAnthropicKey,
} from "@/lib/settings";

/**
 * Read system settings. The Anthropic key is never returned in clear — only
 * whether one is set, and whether the environment variable is overriding the
 * stored value (in which case the DB field is effectively ignored).
 */
export async function GET() {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;

  const s = await getSystemSettings();
  const anthropicKeyFromEnv = !!process.env.ANTHROPIC_API_KEY?.trim();
  return NextResponse.json({
    settings: {
      ollama_url: s.ollama_url,
      ollama_compliance_model: s.ollama_compliance_model,
      ollama_coaching_model: s.ollama_coaching_model,
      ollama_embedding_model: s.ollama_embedding_model,
      ollama_vision_model: s.ollama_vision_model,
      ollama_ingest_model: s.ollama_ingest_model,
      rag_contextual_retrieval: s.rag_contextual_retrieval,
      ollama_num_ctx: s.ollama_num_ctx,
      rag_default_threshold: s.rag_default_threshold,
      default_theme: s.default_theme,
      message_permissions: s.message_permissions,
      cop_create_permissions: s.cop_create_permissions,
      // Key is write-only from the client's perspective.
      anthropic_api_key_set: !!getEffectiveAnthropicKey(s.anthropic_api_key),
      anthropic_api_key_from_env: anthropicKeyFromEnv,
    },
  });
}

/**
 * Update system settings. Fields are applied only when present. The Anthropic
 * key is updated only when a non-empty string is sent, so the UI can leave the
 * field blank to keep the current value.
 */
export async function PATCH(request: NextRequest) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;

  const body = await request.json().catch(() => ({}));
  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const update: Parameters<typeof updateSystemSettings>[0] = {};
  if (typeof body.ollama_url === "string") update.ollama_url = body.ollama_url;
  if (typeof body.ollama_compliance_model === "string")
    update.ollama_compliance_model = body.ollama_compliance_model;
  if (typeof body.ollama_coaching_model === "string")
    update.ollama_coaching_model = body.ollama_coaching_model;
  if (typeof body.ollama_embedding_model === "string")
    update.ollama_embedding_model = body.ollama_embedding_model;
  if (typeof body.ollama_vision_model === "string")
    update.ollama_vision_model = body.ollama_vision_model;
  if (typeof body.ollama_ingest_model === "string")
    update.ollama_ingest_model = body.ollama_ingest_model;
  if (typeof body.rag_contextual_retrieval === "boolean")
    update.rag_contextual_retrieval = body.rag_contextual_retrieval;
  if (body.ollama_num_ctx !== undefined && body.ollama_num_ctx !== null) {
    const n = Number(body.ollama_num_ctx);
    if (Number.isFinite(n) && n >= 0) update.ollama_num_ctx = n;
  }
  if (typeof body.rag_default_threshold === "number")
    update.rag_default_threshold = body.rag_default_threshold;
  if (typeof body.default_theme === "string") update.default_theme = body.default_theme;
  if (body.message_permissions && typeof body.message_permissions === "object") {
    // sender → target → reach ('none'|'school'|'district'). updateSystemSettings
    // coerces/validates against the role matrix, so pass it through.
    update.message_permissions = body.message_permissions as typeof update.message_permissions;
  }
  if (body.cop_create_permissions && typeof body.cop_create_permissions === "object") {
    const cp = body.cop_create_permissions as Record<string, Record<string, unknown>>;
    const out: Record<string, { school: boolean; district: boolean }> = {};
    for (const [k, v] of Object.entries(cp)) {
      out[k] = { school: v?.school === true, district: v?.district === true };
    }
    update.cop_create_permissions = out;
  }
  // Only overwrite the key when a non-empty value is provided.
  if (typeof body.anthropic_api_key === "string" && body.anthropic_api_key.trim() !== "") {
    update.anthropic_api_key = body.anthropic_api_key;
  }

  try {
    await updateSystemSettings(update);
    const fields = Object.keys(update);
    if (fields.length > 0) {
      const adminId = Number(session.user.id);
      // Never record the key's value — just that it changed.
      const labels = fields.map((f) => (f === "anthropic_api_key" ? "anthropic_api_key (set)" : f));
      await logUserEvent({
        userId: adminId,
        actorId: adminId,
        action: "settings_updated",
        detail: labels.join(", "),
      });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to save settings";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
