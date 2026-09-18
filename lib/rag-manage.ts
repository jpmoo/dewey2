import { getPool } from "@/lib/pg";
import { ragAvailable } from "@/lib/db";
import { embedText, toVectorLiteral } from "@/lib/embeddings";
import type { RagPlacement } from "@/lib/rag-ingest";

/** The four standard categories (admin can add more later). */
export async function listRagCategories(): Promise<{ id: number; name: string; description: string | null }[]> {
  const pool = getPool();
  const res = await pool.query(
    "SELECT id, name, description FROM rag_categories ORDER BY sort, name"
  );
  return res.rows.map((r) => ({
    id: r.id as number,
    name: r.name as string,
    description: (r.description as string | null) ?? null,
  }));
}

/** Embed a chunk's text and store the vector (or clear it if embedding failed). */
async function embedChunk(chunkId: number, text: string): Promise<boolean> {
  const pool = getPool();
  const e = await embedText(text);
  if (!e) {
    await pool.query(
      "UPDATE rag_chunks SET embedding = NULL, embed_model = NULL, updated_at = NOW() WHERE id = $1",
      [chunkId]
    );
    return false;
  }
  await pool.query(
    "UPDATE rag_chunks SET embedding = $2::vector, embed_model = $3, updated_at = NOW() WHERE id = $1",
    [chunkId, toVectorLiteral(e.vector), e.model]
  );
  return true;
}

/** Edit a sample's text and re-embed it. */
export async function updateSample(chunkId: number, text: string): Promise<boolean> {
  const pool = getPool();
  const t = text.trim();
  if (!t) throw new Error("A sample can't be empty.");
  await pool.query(
    "UPDATE rag_chunks SET text = $2, edited = TRUE, updated_at = NOW() WHERE id = $1",
    [chunkId, t]
  );
  return embedChunk(chunkId, t);
}

/** Add a new hand-written sample to a document and embed it. */
export async function addSample(documentId: number, text: string): Promise<number> {
  const pool = getPool();
  const t = text.trim();
  if (!t) throw new Error("A sample can't be empty.");
  const ord = await pool.query(
    "SELECT COALESCE(MAX(ordinal), -1) + 1 AS n FROM rag_chunks WHERE document_id = $1",
    [documentId]
  );
  const res = await pool.query(
    "INSERT INTO rag_chunks (document_id, ordinal, text, source) VALUES ($1,$2,$3,'manual') RETURNING id",
    [documentId, ord.rows[0].n as number, t]
  );
  const chunkId = res.rows[0].id as number;
  await embedChunk(chunkId, t);
  return chunkId;
}

export async function deleteSample(chunkId: number): Promise<void> {
  const pool = getPool();
  await pool.query("DELETE FROM rag_chunks WHERE id = $1", [chunkId]);
}

/** Re-embed every sample of a document with the current model (e.g. after a model change). */
export async function reEmbedDocument(documentId: number): Promise<{ total: number; embedded: number }> {
  if (!(await ragAvailable())) throw new Error("RAG is not available.");
  const pool = getPool();
  const res = await pool.query("SELECT id, text FROM rag_chunks WHERE document_id = $1 ORDER BY ordinal", [
    documentId,
  ]);
  let embedded = 0;
  for (const row of res.rows) {
    if (await embedChunk(row.id as number, row.text as string)) embedded += 1;
  }
  return { total: res.rows.length, embedded };
}

/** Add another placement (unit) for a document — no re-embedding needed. */
export async function addPlacement(documentId: number, pl: RagPlacement): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO rag_document_placements (document_id, level, district_id, school_id, cop_id)
     VALUES ($1,$2,$3,$4,$5)`,
    [documentId, pl.level, pl.districtId ?? null, pl.schoolId ?? null, pl.copId ?? null]
  );
}

export async function removePlacement(placementId: number): Promise<void> {
  const pool = getPool();
  await pool.query("DELETE FROM rag_document_placements WHERE id = $1", [placementId]);
}

/** Set a document's categories (replaces the set). */
export async function setDocumentCategories(documentId: number, categoryIds: number[]): Promise<void> {
  const pool = getPool();
  await pool.query("DELETE FROM rag_document_categories WHERE document_id = $1", [documentId]);
  for (const cid of Array.from(new Set(categoryIds))) {
    await pool.query(
      "INSERT INTO rag_document_categories (document_id, category_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [documentId, cid]
    );
  }
}

export async function updateDocumentMeta(
  documentId: number,
  meta: { title?: string; description?: string | null }
): Promise<void> {
  const pool = getPool();
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  if (meta.title !== undefined) {
    sets.push(`title = $${i++}`);
    vals.push(meta.title.trim() || "Untitled");
  }
  if (meta.description !== undefined) {
    sets.push(`description = $${i++}`);
    vals.push(meta.description?.trim() || null);
  }
  if (sets.length === 0) return;
  vals.push(documentId);
  await pool.query(`UPDATE rag_documents SET ${sets.join(", ")} WHERE id = $${i}`, vals);
}

export async function softDeleteDocument(documentId: number): Promise<void> {
  const pool = getPool();
  await pool.query("UPDATE rag_documents SET deleted_at = NOW() WHERE id = $1", [documentId]);
}
