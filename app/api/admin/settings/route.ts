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
      rag_url: s.rag_url,
      rag_default_threshold: s.rag_default_threshold,
      rag_default_collections: s.rag_default_collections,
      default_theme: s.default_theme,
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
  if (typeof body.rag_url === "string") update.rag_url = body.rag_url;
  if (typeof body.rag_default_threshold === "number")
    update.rag_default_threshold = body.rag_default_threshold;
  if (Array.isArray(body.rag_default_collections))
    update.rag_default_collections = body.rag_default_collections.filter(
      (c: unknown): c is string => typeof c === "string"
    );
  if (typeof body.default_theme === "string") update.default_theme = body.default_theme;
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
