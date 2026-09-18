import { getSystemSettings } from "@/lib/settings";

/** Default local embedding model (admin can override in System settings). */
export const DEFAULT_EMBED_MODEL = "nomic-embed-text";

export async function embeddingModel(): Promise<string> {
  const settings = await getSystemSettings();
  return (settings.ollama_embedding_model ?? "").trim() || DEFAULT_EMBED_MODEL;
}

/**
 * Embed a single string via the local Ollama embeddings endpoint. Returns the
 * vector and the model used, or null if embeddings aren't available (no Ollama
 * URL, unreachable, or an empty result) — callers degrade gracefully.
 */
export async function embedText(
  text: string
): Promise<{ vector: number[]; model: string } | null> {
  const t = text.trim();
  if (!t) return null;
  const settings = await getSystemSettings();
  const url = (settings.ollama_url ?? "").trim();
  if (!url) return null;
  const model = (settings.ollama_embedding_model ?? "").trim() || DEFAULT_EMBED_MODEL;
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/api/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt: t }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return null;
    const data = (await res.json().catch(() => ({}))) as { embedding?: unknown };
    const vec = Array.isArray(data.embedding) ? (data.embedding as number[]) : null;
    if (!vec || vec.length === 0 || vec.some((n) => typeof n !== "number")) return null;
    return { vector: vec, model };
  } catch {
    return null;
  }
}

/** Format a JS number[] as a pgvector literal, e.g. "[0.1,0.2,0.3]". */
export function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}
