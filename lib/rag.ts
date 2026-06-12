import { getSystemSettings } from "@/lib/settings";

/**
 * RAGDoll retrieval used to ground AI calls. Queries the configured RAGDoll
 * server (system_settings.rag_url) restricted to the platform default
 * collections (rag_default_collections) at the default threshold.
 * Best-effort: any failure (not configured, unreachable) yields no context so
 * the AI call still proceeds ungrounded.
 */

export interface RagChunk {
  text: string;
  source: string;
  /** RAGDoll fetch path for the source document, e.g. "/fetch/group/file.pdf". */
  sourceUrl: string;
  group: string;
  similarity: number;
}

/** Unique source documents from a set of chunks, in first-seen order. */
export function uniqueSources(chunks: RagChunk[]): { name: string; path: string }[] {
  const seen = new Set<string>();
  const out: { name: string; path: string }[] = [];
  for (const c of chunks) {
    if (!c.source || !c.sourceUrl || seen.has(c.source)) continue;
    seen.add(c.source);
    out.push({ name: c.source, path: c.sourceUrl });
  }
  return out;
}

export async function queryRagDefault(prompt: string, limit = 8): Promise<RagChunk[]> {
  const text = prompt.trim();
  if (!text) return [];
  const settings = await getSystemSettings();
  const url = (settings.rag_url ?? "").trim();
  if (!url) return [];

  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: text,
        group: settings.rag_default_collections ?? [], // [] = all collections
        threshold: settings.rag_default_threshold ?? 0.5,
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return [];
    const data = (await res.json().catch(() => ({}))) as { results?: unknown };
    const results = Array.isArray(data.results) ? data.results : [];
    return results
      .map((r) => {
        const o = (r ?? {}) as Record<string, unknown>;
        return {
          text: typeof o.text === "string" ? o.text : "",
          source: typeof o.source_name === "string" ? o.source_name : "",
          sourceUrl: typeof o.source_url === "string" ? o.source_url : "",
          group: typeof o.group === "string" ? o.group : "",
          similarity: typeof o.similarity === "number" ? o.similarity : 0,
        };
      })
      .filter((c) => c.text)
      .slice(0, limit);
  } catch {
    return [];
  }
}

/** Render retrieved chunks as a context block for a prompt. Empty string if none. */
export function formatRagContext(chunks: RagChunk[]): string {
  if (chunks.length === 0) return "";
  const lines = chunks.map(
    (c, i) => `[${i + 1}] (${c.source || c.group || "source"}) ${c.text}`
  );
  return lines.join("\n\n");
}
