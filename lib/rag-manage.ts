import { getPool } from "@/lib/pg";
import { ragAvailable } from "@/lib/db";
import { embedText, toVectorLiteral } from "@/lib/embeddings";
import { getSystemSettings } from "@/lib/settings";
import {
  embeddableText,
  generateChunkContext,
  ingestModelOf,
  type RagPlacement,
} from "@/lib/rag-ingest";

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

/**
 * Embed a chunk (its Contextual-Retrieval header + verbatim text) and store the
 * vector, or clear it if embedding failed. The context is read from the row so
 * callers only need to pass the text they just wrote.
 */
async function embedChunk(chunkId: number, text: string): Promise<boolean> {
  const pool = getPool();
  const ctxRes = await pool.query("SELECT context FROM rag_chunks WHERE id = $1", [chunkId]);
  const context = (ctxRes.rows[0]?.context as string | null) ?? null;
  const e = await embedText(embeddableText(context, text));
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

/**
 * Re-embed every sample of a document applying the *current* ingest settings:
 * when contextual retrieval is on, each chunk's context header is regenerated
 * from the whole document with the current ingest model; when it's off, stored
 * context is cleared. The verbatim chunk text is preserved (edits and manual
 * samples are kept). Writes progress/status to the row and runs to completion in
 * the background, so callers should fire-and-forget it.
 */
export async function reEmbedDocument(documentId: number): Promise<{ total: number; embedded: number }> {
  if (!(await ragAvailable())) throw new Error("RAG is not available.");
  const pool = getPool();
  try {
    const dRes = await pool.query(
      "SELECT extracted_text FROM rag_documents WHERE id = $1 AND deleted_at IS NULL",
      [documentId]
    );
    const docText = ((dRes.rows[0]?.extracted_text as string | null) ?? "").trim();
    const settings = await getSystemSettings();
    const res = await pool.query(
      "SELECT id, text FROM rag_chunks WHERE document_id = $1 ORDER BY ordinal",
      [documentId]
    );
    const total = res.rows.length;
    const useContext = settings.rag_contextual_retrieval && !!docText && total > 1;
    const ctxModel = ingestModelOf(settings);

    await pool.query(
      "UPDATE rag_documents SET status = 'processing', status_detail = 'Re-embedding…' WHERE id = $1",
      [documentId]
    );

    let embedded = 0;
    for (let i = 0; i < res.rows.length; i++) {
      const id = res.rows[i].id as number;
      const text = res.rows[i].text as string;
      // Regenerate (or clear) the context header per current settings, then embed
      // it together with the verbatim text via embedChunk (which reads it back).
      const context = useContext ? await generateChunkContext(docText, text, ctxModel) : null;
      await pool.query("UPDATE rag_chunks SET context = $2 WHERE id = $1", [id, context]);
      if (await embedChunk(id, text)) embedded += 1;
      if (i % 2 === 0 || i === res.rows.length - 1) {
        await pool.query("UPDATE rag_documents SET status_detail = $2 WHERE id = $1", [
          documentId,
          `${useContext ? "Contextualizing" : "Re-embedding"} ${embedded}/${total}…`,
        ]);
      }
    }

    const ctxNote = useContext ? " (with contextual retrieval)" : "";
    const note =
      embedded === total
        ? `${embedded}/${total} samples embedded${ctxNote}.`
        : `${embedded}/${total} embedded${ctxNote} — the embedding model was unavailable for the rest.`;
    await pool.query(
      "UPDATE rag_documents SET status = 'ready', status_detail = $2, processed_at = NOW() WHERE id = $1",
      [documentId, note]
    );
    return { total, embedded };
  } catch (e) {
    await pool
      .query("UPDATE rag_documents SET status = 'error', status_detail = $2 WHERE id = $1", [
        documentId,
        e instanceof Error ? e.message : "Re-embed failed",
      ])
      .catch(() => {});
    throw e;
  }
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

// ---- Read models for the Documents admin UI ------------------------------

export interface RagPlacementRow {
  id: number;
  level: string;
  districtId: number | null;
  schoolId: number | null;
  copId: number | null;
  label: string;
}
export type RagDocStatus = "processing" | "ready" | "error";
export interface RagDocSummary {
  id: number;
  title: string;
  description: string | null;
  createdAt: string;
  samples: number;
  embedded: number;
  status: RagDocStatus;
  statusDetail: string | null;
  chunkTotal: number | null;
  categories: { id: number; name: string }[];
  placements: RagPlacementRow[];
}
export interface RagSample {
  id: number;
  ordinal: number;
  text: string;
  /** Contextual-Retrieval header embedded alongside the text (null if none). */
  context: string | null;
  source: string;
  edited: boolean;
  embedded: boolean;
}
export interface RagDocDetail extends RagDocSummary {
  filename: string | null;
  mime: string | null;
  /** Character length of the extracted text — reveals truncated vs full-text ingest. */
  extractedChars: number;
  samplesList: RagSample[];
}

function placementLabel(r: {
  level: string;
  district_name: string | null;
  school_name: string | null;
  cop_id: number | null;
  cop_subject?: string | null;
}): string {
  if (r.level === "system") return "System-wide";
  if (r.level === "district") return r.district_name ?? "District";
  if (r.level === "school")
    return r.school_name ? `${r.district_name ? r.district_name + " · " : ""}${r.school_name}` : "School";
  if (r.level === "cop") return `CoP · ${r.cop_subject || `#${r.cop_id ?? "?"}`}`;
  return r.level;
}

async function placementsFor(docIds: number[]): Promise<Map<number, RagPlacementRow[]>> {
  const map = new Map<number, RagPlacementRow[]>();
  if (docIds.length === 0) return map;
  const pool = getPool();
  const res = await pool.query(
    `SELECT pl.id, pl.document_id, pl.level, pl.district_id, pl.school_id, pl.cop_id,
            di.name AS district_name, s.name AS school_name, mt.subject AS cop_subject
       FROM rag_document_placements pl
       LEFT JOIN districts di ON di.id = pl.district_id
       LEFT JOIN schools s ON s.id = pl.school_id
       LEFT JOIN message_threads mt ON mt.id = pl.cop_id
      WHERE pl.document_id = ANY($1::bigint[])
      ORDER BY pl.id`,
    [docIds]
  );
  for (const r of res.rows) {
    const arr = map.get(r.document_id as number) ?? [];
    arr.push({
      id: r.id as number,
      level: r.level as string,
      districtId: (r.district_id as number | null) ?? null,
      schoolId: (r.school_id as number | null) ?? null,
      copId: (r.cop_id as number | null) ?? null,
      label: placementLabel(r),
    });
    map.set(r.document_id as number, arr);
  }
  return map;
}

async function categoriesFor(docIds: number[]): Promise<Map<number, { id: number; name: string }[]>> {
  const map = new Map<number, { id: number; name: string }[]>();
  if (docIds.length === 0) return map;
  const pool = getPool();
  const res = await pool.query(
    `SELECT dc.document_id, c.id, c.name FROM rag_document_categories dc
       JOIN rag_categories c ON c.id = dc.category_id
      WHERE dc.document_id = ANY($1::bigint[]) ORDER BY c.sort, c.name`,
    [docIds]
  );
  for (const r of res.rows) {
    const arr = map.get(r.document_id as number) ?? [];
    arr.push({ id: r.id as number, name: r.name as string });
    map.set(r.document_id as number, arr);
  }
  return map;
}

export async function listRagDocuments(q = ""): Promise<RagDocSummary[]> {
  const pool = getPool();
  const term = q.trim();
  const res = await pool.query(
    `SELECT d.id, d.title, d.description, d.created_at, d.status, d.status_detail, d.chunk_total,
            COUNT(ch.id)::int AS samples,
            COUNT(ch.id) FILTER (WHERE ch.embedding IS NOT NULL)::int AS embedded
       FROM rag_documents d
       LEFT JOIN rag_chunks ch ON ch.document_id = d.id
      WHERE d.deleted_at IS NULL
        AND ($1 = '' OR d.title ILIKE '%'||$1||'%' OR d.description ILIKE '%'||$1||'%'
             OR d.extracted_text ILIKE '%'||$1||'%')
      GROUP BY d.id
      ORDER BY d.created_at DESC`,
    [term]
  );
  const ids = res.rows.map((r) => r.id as number);
  const [cats, places] = await Promise.all([categoriesFor(ids), placementsFor(ids)]);
  return res.rows.map((r) => ({
    id: r.id as number,
    title: r.title as string,
    description: (r.description as string | null) ?? null,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    samples: r.samples as number,
    embedded: r.embedded as number,
    status: ((r.status as string) ?? "ready") as RagDocStatus,
    statusDetail: (r.status_detail as string | null) ?? null,
    chunkTotal: (r.chunk_total as number | null) ?? null,
    categories: cats.get(r.id as number) ?? [],
    placements: places.get(r.id as number) ?? [],
  }));
}

export async function getRagDocumentDetail(id: number): Promise<RagDocDetail | null> {
  const pool = getPool();
  const dRes = await pool.query(
    `SELECT id, title, description, filename, mime, created_at, status, status_detail, chunk_total,
            COALESCE(char_length(extracted_text), 0) AS extracted_chars
       FROM rag_documents WHERE id = $1 AND deleted_at IS NULL`,
    [id]
  );
  const d = dRes.rows[0];
  if (!d) return null;
  const [cats, places] = await Promise.all([categoriesFor([id]), placementsFor([id])]);
  const sRes = await pool.query(
    `SELECT id, ordinal, text, context, source, edited, (embedding IS NOT NULL) AS embedded
       FROM rag_chunks WHERE document_id = $1 ORDER BY ordinal`,
    [id]
  );
  return {
    id: d.id as number,
    title: d.title as string,
    description: (d.description as string | null) ?? null,
    filename: (d.filename as string | null) ?? null,
    mime: (d.mime as string | null) ?? null,
    createdAt: d.created_at instanceof Date ? d.created_at.toISOString() : String(d.created_at),
    samples: sRes.rows.length,
    embedded: sRes.rows.filter((r) => r.embedded).length,
    status: ((d.status as string) ?? "ready") as RagDocStatus,
    statusDetail: (d.status_detail as string | null) ?? null,
    chunkTotal: (d.chunk_total as number | null) ?? null,
    extractedChars: Number(d.extracted_chars ?? 0),
    categories: cats.get(id) ?? [],
    placements: places.get(id) ?? [],
    samplesList: sRes.rows.map((r) => ({
      id: r.id as number,
      ordinal: r.ordinal as number,
      text: r.text as string,
      context: (r.context as string | null) ?? null,
      source: r.source as string,
      edited: r.edited as boolean,
      embedded: r.embedded as boolean,
    })),
  };
}

/**
 * Build a plain-text diagnostic report for one document: metadata, the full
 * extracted text, and every chunk (source, context, embedding state, text). Used
 * by the admin "Download" action to inspect what ingest produced. Returns null
 * when the document doesn't exist.
 */
export async function exportRagDocumentReport(
  id: number
): Promise<{ filename: string; text: string } | null> {
  const pool = getPool();
  const dRes = await pool.query(
    `SELECT id, title, description, filename, mime, status, status_detail, chunk_total,
            COALESCE(char_length(extracted_text), 0) AS chars, extracted_text,
            octet_length(bytes) AS byte_len, created_at, processed_at
       FROM rag_documents WHERE id = $1 AND deleted_at IS NULL`,
    [id]
  );
  const d = dRes.rows[0];
  if (!d) return null;
  const cRes = await pool.query(
    `SELECT ordinal, source, edited, context, embed_model,
            (embedding IS NOT NULL) AS embedded, text
       FROM rag_chunks WHERE document_id = $1 ORDER BY ordinal`,
    [id]
  );

  const rule = (label: string) => `\n${"=".repeat(78)}\n${label}\n${"=".repeat(78)}\n`;
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? "(never)" : String(v));
  const out: string[] = [];
  out.push(rule(`DOCUMENT #${d.id}: ${d.title}`));
  out.push(`filename:      ${d.filename ?? "(none)"}`);
  out.push(`mime:          ${d.mime ?? "(none)"}`);
  out.push(`stored bytes:  ${d.byte_len == null ? "(none)" : Number(d.byte_len).toLocaleString()}`);
  out.push(`status:        ${d.status}  — ${d.status_detail ?? ""}`);
  out.push(`extracted:     ${Number(d.chars).toLocaleString()} chars`);
  out.push(`chunk_total:   ${d.chunk_total ?? "(null)"}`);
  out.push(`chunks in db:  ${cRes.rows.length}`);
  out.push(`created:       ${iso(d.created_at)}`);
  out.push(`processed:     ${iso(d.processed_at)}`);
  out.push(`description:   ${d.description ?? "(none)"}`);

  out.push(rule("FULL EXTRACTED TEXT (verbatim, as stored)"));
  out.push((d.extracted_text as string | null) ?? "(empty)");

  out.push(rule(`CHUNKS / SAMPLES (${cRes.rows.length})`));
  for (const r of cRes.rows) {
    out.push(
      `\n----- #${(r.ordinal as number) + 1}  source=${r.source}  edited=${r.edited}  ` +
        `embedded=${r.embedded}  model=${r.embed_model ?? "-"}  (${((r.text as string) ?? "").length} chars) -----`
    );
    if (r.context) out.push(`[context] ${r.context}`);
    out.push((r.text as string) ?? "");
  }

  const slug = String(d.title ?? "document").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "document";
  return { filename: `rag-export-${id}-${slug}.txt`, text: out.join("\n") };
}
