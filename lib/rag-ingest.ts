import { getPool } from "@/lib/pg";
import { ragAvailable } from "@/lib/db";
import { extractText } from "@/lib/extract";
import { embedText, toVectorLiteral } from "@/lib/embeddings";

export type RagLevel = "system" | "district" | "school" | "cop";

export interface IngestParams {
  level: RagLevel;
  districtId?: number | null;
  schoolId?: number | null;
  copId?: number | null;
  title: string;
  filename?: string | null;
  mime?: string | null;
  /** Raw file bytes (optional if extractedText is supplied directly). */
  bytes?: Buffer | null;
  /** Pre-extracted text (e.g. a typed/pasted document); else extracted from bytes. */
  extractedText?: string | null;
  categoryIds: number[];
  uploadedBy?: number | null;
}

/**
 * Split text into overlapping chunks (~target chars, paragraph-aware) for
 * embedding. A single oversized paragraph is hard-split.
 */
export function chunkText(text: string, target = 1200, overlap = 150): string[] {
  const clean = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!clean) return [];
  const paras = clean.split(/\n\n+/);
  const chunks: string[] = [];
  let cur = "";
  const flush = () => {
    const c = cur.trim();
    if (c) chunks.push(c);
  };
  for (let p of paras) {
    while (p.length > target * 1.5) {
      if (cur) flush();
      chunks.push(p.slice(0, target).trim());
      p = p.slice(target - overlap);
      cur = "";
    }
    if (cur && (cur.length + p.length + 2) > target) {
      flush();
      const tail = cur.slice(Math.max(0, cur.length - overlap));
      cur = tail ? tail + "\n\n" + p : p;
    } else {
      cur = cur ? cur + "\n\n" + p : p;
    }
  }
  flush();
  return chunks;
}

export interface IngestResult {
  documentId: number;
  chunks: number;
  embedded: number;
  model: string | null;
}

/**
 * Ingest one document into the RAG store: extract text (if needed), persist the
 * document + its category links, then chunk, embed, and store each chunk. This is
 * the UX-agnostic core reused by whatever ingest UI we build.
 */
export async function ingestDocument(params: IngestParams): Promise<IngestResult> {
  if (!(await ragAvailable())) {
    throw new Error("RAG is not available (pgvector/Ollama not configured).");
  }
  const pool = getPool();

  let text = (params.extractedText ?? "").trim();
  if (!text && params.bytes) {
    text = (await extractText(params.filename ?? "", params.mime ?? "", params.bytes)) ?? "";
  }
  text = text.trim();

  const res = await pool.query(
    `INSERT INTO rag_documents
       (level, district_id, school_id, cop_id, title, filename, mime, bytes, extracted_text, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id`,
    [
      params.level,
      params.districtId ?? null,
      params.schoolId ?? null,
      params.copId ?? null,
      params.title.trim() || params.filename || "Untitled",
      params.filename ?? null,
      params.mime ?? null,
      params.bytes ?? null,
      text || null,
      params.uploadedBy ?? null,
    ]
  );
  const documentId = res.rows[0].id as number;

  for (const cid of Array.from(new Set(params.categoryIds))) {
    await pool.query(
      "INSERT INTO rag_document_categories (document_id, category_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [documentId, cid]
    );
  }

  const chunks = chunkText(text);
  let embedded = 0;
  let model: string | null = null;
  for (let i = 0; i < chunks.length; i++) {
    const e = await embedText(chunks[i]);
    if (!e) continue; // Ollama unavailable for this chunk — skip; can re-embed later.
    model = e.model;
    await pool.query(
      `INSERT INTO rag_chunks (document_id, ordinal, text, embed_model, embedding)
       VALUES ($1,$2,$3,$4,$5::vector)`,
      [documentId, i, chunks[i], e.model, toVectorLiteral(e.vector)]
    );
    embedded += 1;
  }
  return { documentId, chunks: chunks.length, embedded, model };
}
