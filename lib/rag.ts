import { getPool } from "@/lib/pg";
import { getSystemSettings } from "@/lib/settings";
import { ragAvailable } from "@/lib/db";
import { embedText, toVectorLiteral } from "@/lib/embeddings";
import type { SourceSelector } from "@/lib/templates";

/**
 * In-house RAG retrieval (Ollama embeddings + Postgres/pgvector), replacing the
 * external RAGDoll PoC. The RagChunk/source shape is preserved so the callers
 * (@dewey chat, coach-review consult, canvas assistant) and the source-link pills
 * are unchanged. Best-effort: any failure (RAG unavailable, Ollama down) yields no
 * context so the AI call still proceeds ungrounded.
 */

export interface RagChunk {
  text: string;
  source: string;
  /** In-house serving path for the source document. */
  sourceUrl: string;
  group: string;
  similarity: number;
}

/** Where to look: the org units in scope, and which buckets/docs to include. */
export interface RagScope {
  districtId?: number | null;
  /** The coachee's buildings (school-level docs). */
  schoolIds?: number[];
  /** A Community of Practice's own store. */
  copId?: number | null;
  /** Category ids to include; null/undefined = all categories ("default is all"). */
  categoryIds?: number[] | null;
  /** Specific documents to always include (pinned individual sources). */
  documentIds?: number[];
}

/** Unique source documents from a set of chunks, in first-seen order. */
export function uniqueSources(chunks: RagChunk[]): { name: string; path: string }[] {
  const seen = new Set<string>();
  const out: { name: string; path: string }[] = [];
  for (const c of chunks) {
    if (!c.source || !c.sourceUrl || seen.has(c.sourceUrl)) continue;
    seen.add(c.sourceUrl);
    out.push({ name: c.source, path: c.sourceUrl });
  }
  return out;
}

/**
 * Retrieve the most similar chunks to `prompt` within `scope`. The query is
 * embedded with the current model and compared only against chunks embedded with
 * that same model (so switching the embedding model never mixes vector spaces).
 */
export async function queryRag(prompt: string, scope: RagScope = {}, limit = 8): Promise<RagChunk[]> {
  const text = prompt.trim();
  if (!text) return [];
  if (!(await ragAvailable())) return [];
  const embedded = await embedText(text);
  if (!embedded) return [];

  const settings = await getSystemSettings();
  const floor = settings.rag_default_threshold ?? 0.5;
  const categoryIds = scope.categoryIds ?? null;
  const allCategories = categoryIds == null; // null = every category
  const pool = getPool();

  try {
    const res = await pool.query(
      `SELECT c.text, d.id AS doc_id, d.title,
              1 - (c.embedding <=> $1::vector) AS similarity
         FROM rag_chunks c
         JOIN rag_documents d ON d.id = c.document_id AND d.deleted_at IS NULL
        WHERE c.embed_model = $2 AND c.embedding IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM rag_document_placements pl
             WHERE pl.document_id = d.id AND (
               pl.level = 'system'
               OR (pl.level = 'district' AND pl.district_id = $3)
               OR (pl.level = 'school'   AND pl.school_id = ANY($4::int[]))
               OR (pl.level = 'cop'      AND pl.cop_id = $5)
             )
          )
          AND (
            $6::boolean
            OR d.id = ANY($7::bigint[])
            OR EXISTS (
              SELECT 1 FROM rag_document_categories dc
               WHERE dc.document_id = d.id AND dc.category_id = ANY($8::bigint[])
            )
          )
        ORDER BY c.embedding <=> $1::vector
        LIMIT $9`,
      [
        toVectorLiteral(embedded.vector),
        embedded.model,
        scope.districtId ?? null,
        scope.schoolIds ?? [],
        scope.copId ?? null,
        allCategories,
        scope.documentIds ?? [],
        allCategories ? [] : categoryIds,
        limit,
      ]
    );
    return res.rows
      .map((r) => ({
        text: (r.text as string) ?? "",
        source: (r.title as string) ?? "source",
        sourceUrl: `/api/rag/documents/${r.doc_id}`,
        group: (r.level as string) ?? "",
        similarity: typeof r.similarity === "number" ? r.similarity : 0,
      }))
      .filter((c) => c.text && c.similarity >= floor);
  } catch (e) {
    console.warn("[rag] query failed:", e instanceof Error ? e.message : e);
    return [];
  }
}

/**
 * Backward-compatible default query used by the current call sites. Until node/arc
 * source scoping is wired in (next phase), this searches all categories in the
 * given scope (system-level only when no scope is provided).
 */
export async function queryRagDefault(prompt: string, limit = 8): Promise<RagChunk[]> {
  return queryRag(prompt, {}, limit);
}

/**
 * Merge a node's sources with the arc's standing sources into query filters.
 * Returns categoryIds=null for "all categories" (the default when nothing is set).
 */
export function mergeSelectors(
  node?: SourceSelector | null,
  standing?: SourceSelector | null
): { categoryIds: number[] | null; documentIds: number[] } {
  const nodeAll = node ? node.all : true; // no node selector = all
  const standAll = standing ? standing.all : false;
  const documentIds = Array.from(
    new Set([...(node?.documentIds ?? []), ...(standing?.documentIds ?? [])])
  );
  if (nodeAll || standAll) return { categoryIds: null, documentIds };
  const categoryIds = Array.from(
    new Set([...(node?.categoryIds ?? []), ...(standing?.categoryIds ?? [])])
  );
  return { categoryIds, documentIds };
}

/** Render retrieved chunks as a context block for a prompt. Empty string if none. */
export function formatRagContext(chunks: RagChunk[]): string {
  if (chunks.length === 0) return "";
  return chunks.map((c, i) => `[${i + 1}] (${c.source || c.group || "source"}) ${c.text}`).join("\n\n");
}
