import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";
import { ragAvailable } from "@/lib/db";
import { getPool } from "@/lib/pg";
import { processDocument } from "@/lib/rag-ingest";

/**
 * Re-run ingest for a document from its stored bytes (or pasted text) — used to
 * retry after a failed/interrupted job. Marks the row 'processing' and kicks off
 * the background worker, returning immediately.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;
  if (!(await ragAvailable())) {
    return NextResponse.json({ error: "RAG isn't available." }, { status: 400 });
  }
  const docId = parseInt((await params).id, 10);
  if (!Number.isFinite(docId)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const pool = getPool();
  const res = await pool.query(
    "SELECT filename, mime, bytes, extracted_text FROM rag_documents WHERE id = $1 AND deleted_at IS NULL",
    [docId]
  );
  const row = res.rows[0];
  if (!row) return NextResponse.json({ error: "Document not found" }, { status: 404 });

  const bytes: Buffer | null = row.bytes ?? null;
  const pastedText: string | null = bytes ? null : (row.extracted_text as string | null) ?? null;
  if (!bytes && !pastedText) {
    return NextResponse.json(
      { error: "Nothing to re-process — the original content is no longer stored." },
      { status: 400 }
    );
  }

  await pool.query(
    "UPDATE rag_documents SET status = 'processing', status_detail = 'Queued…' WHERE id = $1",
    [docId]
  );
  void processDocument(docId, {
    filename: (row.filename as string | null) ?? null,
    mime: (row.mime as string | null) ?? null,
    bytes,
    pastedText,
  }).catch(async (e) => {
    await pool
      .query("UPDATE rag_documents SET status = 'error', status_detail = $2 WHERE id = $1", [
        docId,
        e instanceof Error ? e.message : "Ingest failed",
      ])
      .catch(() => {});
  });

  return NextResponse.json({ ok: true, status: "processing" });
}
