import { getPool } from "@/lib/pg";
import { ragAvailable } from "@/lib/db";
import { extractDocument, fetchUrlText } from "@/lib/rag-extract";
import { embedText, toVectorLiteral } from "@/lib/embeddings";
import { chatComplete } from "@/lib/ai";
import { getSystemSettings } from "@/lib/settings";

export type RagLevel = "system" | "district" | "school" | "cop";

/** One place a document is available. */
export interface RagPlacement {
  level: RagLevel;
  districtId?: number | null;
  schoolId?: number | null;
  copId?: number | null;
}

export interface IngestParams {
  title: string;
  description?: string | null;
  filename?: string | null;
  mime?: string | null;
  /** Raw file bytes (optional if extractedText is supplied directly). */
  bytes?: Buffer | null;
  /** Pre-extracted text (e.g. a typed/pasted document); else extracted from bytes. */
  extractedText?: string | null;
  /** Source web page to fetch + ingest (citations link here). */
  sourceUrl?: string | null;
  categoryIds: number[];
  /** Where the document is available (one or more units). */
  placements: RagPlacement[];
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
  // Take the trailing ~overlap chars of a chunk to prepend to the next one, but
  // snap the start to a clean boundary so it never begins mid-word (prefer the
  // start of a sentence, else the next whole word).
  const overlapTail = (s: string): string => {
    let tail = s.slice(Math.max(0, s.length - overlap));
    const sentence = tail.search(/[.!?]["')\]]?\s+/);
    if (sentence >= 0) return tail.slice(sentence + 1).replace(/^["')\]\s]+/, "");
    const space = tail.search(/\s/);
    return space >= 0 ? tail.slice(space + 1) : tail;
  };
  for (let p of paras) {
    while (p.length > target * 1.5) {
      if (cur) flush();
      chunks.push(p.slice(0, target).trim());
      // Continue after an overlap, snapped to the next word boundary.
      p = p.slice(target - overlap);
      const space = p.search(/\s/);
      if (space >= 0) p = p.slice(space + 1);
      cur = "";
    }
    if (cur && (cur.length + p.length + 2) > target) {
      flush();
      const tail = overlapTail(cur);
      cur = tail ? tail + "\n\n" + p : p;
    } else {
      cur = cur ? cur + "\n\n" + p : p;
    }
  }
  flush();
  return chunks;
}

export interface StartIngestResult {
  documentId: number;
}

async function setStatus(
  documentId: number,
  status: "processing" | "ready" | "error",
  detail: string | null
): Promise<void> {
  await getPool().query(
    "UPDATE rag_documents SET status = $2, status_detail = $3 WHERE id = $1",
    [documentId, status, detail]
  );
}

function methodsNote(methods: string[]): string {
  return methods.length ? `Read via ${methods.join(", ")}. ` : "";
}

/**
 * Draft a short catalog description from the document's own text using the
 * configured coaching model. Best-effort: returns null if no model is set or the
 * call fails, so ingest never depends on it. The admin can edit it afterward.
 */
async function generateDescription(text: string): Promise<string | null> {
  const sample = text.slice(0, 6000).trim();
  if (!sample) return null;
  try {
    const settings = await getSystemSettings();
    const { text: out } = await chatComplete({
      model: ingestModelOf(settings),
      system:
        "You write concise catalog descriptions for a document library used by school and " +
        "district leadership coaches. Given the beginning of a document, write 1–2 sentences " +
        "(about 40 words max) that say what the document is and its purpose. Be specific and " +
        "factual — no marketing language. Output only the description: no preamble, no quotation marks.",
      messages: [{ role: "user", content: sample }],
      maxTokens: 160,
    });
    const d = out.trim().replace(/^["']+|["']+$/g, "").trim();
    return d || null;
  } catch (e) {
    console.warn("[rag] description generation failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

/** The ingest model, or undefined to fall back to the coaching model. */
export function ingestModelOf(settings: { ollama_ingest_model: string | null }): string | undefined {
  return (settings.ollama_ingest_model ?? "").trim() || undefined;
}

/**
 * Contextual Retrieval: ask the ingest model to write a 1–2 sentence header that
 * situates one verbatim chunk within the whole document. This header is embedded
 * together with the chunk (not stored in its place), which markedly improves
 * recall on long documents. The whole document is passed — the real limit is the
 * model's context window (num_ctx), not an arbitrary character cap. Best-effort:
 * returns null on any failure so ingest falls back to embedding the chunk alone.
 */
export async function generateChunkContext(
  docText: string,
  chunk: string,
  model: string | undefined
): Promise<string | null> {
  try {
    const { text: out } = await chatComplete({
      model,
      system:
        "You improve search retrieval for a document library. You are given a whole document and " +
        "one chunk taken from it. Write a short, standalone context (1–2 sentences, ~50 words) that " +
        "situates the chunk within the document — what section/topic it belongs to and what it is " +
        "about — using specific names and terms so the chunk can be found on its own. Do not repeat " +
        "the chunk or add new facts. Output only the context sentence(s).",
      messages: [
        {
          role: "user",
          content: `<document>\n${docText}\n</document>\n\n<chunk>\n${chunk}\n</chunk>\n\nContext:`,
        },
      ],
      maxTokens: 120,
    });
    const c = out.trim().replace(/^["']+|["']+$/g, "").trim();
    return c || null;
  } catch (e) {
    console.warn("[rag] chunk context failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

/** The text actually embedded for a chunk: its context header + the verbatim text. */
export function embeddableText(context: string | null, text: string): string {
  return context ? `${context}\n\n${text}` : text;
}

/**
 * Create the document row immediately (status = 'processing') and kick off the
 * heavy extract → chunk → embed work in the background, returning as soon as the
 * row exists. Extraction (LibreOffice, OCR, vision) can take minutes, far longer
 * than an HTTP request should block; the admin UI polls status/progress instead.
 * The raw upload bytes are stored so the job can be retried after a failure or a
 * server restart.
 */
export async function startIngest(params: IngestParams): Promise<StartIngestResult> {
  if (!(await ragAvailable())) {
    throw new Error("RAG is not available (pgvector/Ollama not configured).");
  }
  const pool = getPool();

  const res = await pool.query(
    `INSERT INTO rag_documents
       (title, description, filename, mime, bytes, extracted_text, source_url, uploaded_by, status, status_detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'processing','Queued…')
     RETURNING id`,
    [
      params.title.trim() || params.filename || "Untitled",
      params.description?.trim() || null,
      params.filename ?? null,
      params.mime ?? null,
      params.bytes ?? null,
      params.extractedText?.trim() || null,
      params.sourceUrl?.trim() || null,
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
  for (const pl of params.placements) {
    await pool.query(
      `INSERT INTO rag_document_placements (document_id, level, district_id, school_id, cop_id)
       VALUES ($1,$2,$3,$4,$5)`,
      [documentId, pl.level, pl.districtId ?? null, pl.schoolId ?? null, pl.copId ?? null]
    );
  }

  // Fire-and-forget: this deploys as a long-running Node server, so the promise
  // keeps running after the response is sent. Errors are captured onto the row.
  void processDocument(documentId, {
    filename: params.filename ?? null,
    mime: params.mime ?? null,
    bytes: params.bytes ?? null,
    pastedText: params.extractedText ?? null,
    sourceUrl: params.sourceUrl ?? null,
  }).catch(async (e) => {
    await setStatus(documentId, "error", e instanceof Error ? e.message : "Ingest failed").catch(() => {});
  });

  return { documentId };
}

export interface ProcessSource {
  filename: string | null;
  mime: string | null;
  bytes: Buffer | null;
  /** Pre-supplied text (pasted document); when present, extraction is skipped. */
  pastedText: string | null;
  /** A web page to fetch + extract when there's no pasted text or bytes. */
  sourceUrl?: string | null;
}

/**
 * The background worker: extract text (if needed), (re)chunk, and embed each
 * chunk, writing progress and a final status onto the document row. Safe to run
 * again on the same document (it clears prior chunks first), which is how retry
 * and re-processing after a model change work.
 */
export async function processDocument(documentId: number, src: ProcessSource): Promise<void> {
  const pool = getPool();
  try {
    await setStatus(documentId, "processing", "Extracting…");

    // Pasted text is used as-is; an uploaded file runs the full extract pipeline
    // (native text + normalize-to-PDF + OCR + vision). We store the normalized
    // PDF as the served artifact when the pipeline produced one.
    let text = (src.pastedText ?? "").trim();
    let storeBytes = src.bytes ?? null;
    let storeMime = src.mime ?? null;
    let methods: string[] = [];
    let warnings: string[] = [];
    if (!text && src.bytes) {
      const ex = await extractDocument(src.filename ?? "", src.mime ?? "", src.bytes);
      text = ex.text.trim();
      methods = ex.methods;
      warnings = ex.warnings;
      if (ex.pdfBytes) {
        storeBytes = ex.pdfBytes;
        storeMime = "application/pdf";
      }
    } else if (!text && src.sourceUrl) {
      // Fetch + extract a web page (or linked PDF).
      await setStatus(documentId, "processing", "Fetching page…");
      const fetched = await fetchUrlText(src.sourceUrl);
      text = fetched.text.trim();
      methods = ["web"];
    }

    // Clear any chunks from a prior run (retry / re-process) before re-chunking.
    await pool.query("DELETE FROM rag_chunks WHERE document_id = $1", [documentId]);
    const chunks = chunkText(text);
    await pool.query(
      "UPDATE rag_documents SET extracted_text = $2, bytes = $3, mime = $4, chunk_total = $5 WHERE id = $1",
      [documentId, text || null, storeBytes, storeMime, chunks.length]
    );

    // Auto-draft a description from the text when the admin left it blank; they
    // can edit it later. Best-effort and non-fatal.
    if (text) {
      const cur = await pool.query(
        "SELECT description FROM rag_documents WHERE id = $1",
        [documentId]
      );
      const hasDesc = ((cur.rows[0]?.description as string | null) ?? "").trim().length > 0;
      if (!hasDesc) {
        await setStatus(documentId, "processing", "Summarizing…");
        const desc = await generateDescription(text);
        if (desc) {
          await pool.query("UPDATE rag_documents SET description = $2 WHERE id = $1", [
            documentId,
            desc,
          ]);
        }
      }
    }

    if (chunks.length === 0) {
      await setStatus(
        documentId,
        "error",
        "No text could be extracted from this file. Try pasting the text, or install the extraction tools."
      );
      return;
    }

    // Contextual Retrieval: when enabled, situate each chunk within the whole
    // document before embedding. Skipped for a single chunk (nothing to situate).
    const settings = await getSystemSettings();
    const useContext = settings.rag_contextual_retrieval && chunks.length > 1;
    const ctxModel = ingestModelOf(settings);

    let embedded = 0;
    for (let i = 0; i < chunks.length; i++) {
      const context = useContext ? await generateChunkContext(text, chunks[i], ctxModel) : null;
      const e = await embedText(embeddableText(context, chunks[i]));
      if (e) {
        await pool.query(
          `INSERT INTO rag_chunks (document_id, ordinal, text, context, embed_model, embedding)
           VALUES ($1,$2,$3,$4,$5,$6::vector)`,
          [documentId, i, chunks[i], context, e.model, toVectorLiteral(e.vector)]
        );
        embedded += 1;
      } else {
        // Store the chunk (and any context) unembedded so it's visible and can be
        // re-embedded later.
        await pool.query(
          "INSERT INTO rag_chunks (document_id, ordinal, text, context) VALUES ($1,$2,$3,$4)",
          [documentId, i, chunks[i], context]
        );
      }
      if (i % 2 === 0 || i === chunks.length - 1) {
        const verb = useContext ? "Contextualizing" : "Embedding";
        await pool.query("UPDATE rag_documents SET status_detail = $2 WHERE id = $1", [
          documentId,
          `${methodsNote(methods)}${verb} ${embedded}/${chunks.length}…`,
        ]);
      }
    }

    const ctxNote = useContext ? " (with contextual retrieval)" : "";
    const warnNote = warnings.length ? ` ⚠️ ${warnings.join(" ")}` : "";
    const note =
      embedded === chunks.length
        ? `${methodsNote(methods)}${embedded}/${chunks.length} samples embedded${ctxNote}.${warnNote}`
        : `${methodsNote(methods)}${embedded}/${chunks.length} embedded${ctxNote} — the embedding model was unavailable for the rest. Use Re-embed once it's reachable.${warnNote}`;
    await pool.query("UPDATE rag_documents SET processed_at = NOW() WHERE id = $1", [documentId]);
    await setStatus(documentId, "ready", note);
  } catch (e) {
    await setStatus(documentId, "error", e instanceof Error ? e.message : "Ingest failed");
  }
}
