import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";
import { ragAvailable } from "@/lib/db";
import { getPool } from "@/lib/pg";
import { reEmbedDocument } from "@/lib/rag-manage";

/**
 * Re-embed a document with the current ingest settings (regenerating contextual
 * headers when enabled). This can take a while, so it runs in the background and
 * writes progress/status to the row; the client polls the list.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;
  if (!(await ragAvailable())) {
    return NextResponse.json({ error: "RAG isn't available." }, { status: 400 });
  }
  const docId = parseInt((await params).id, 10);
  if (!Number.isFinite(docId)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  await getPool().query(
    "UPDATE rag_documents SET status = 'processing', status_detail = 'Queued…' WHERE id = $1 AND deleted_at IS NULL",
    [docId]
  );
  void reEmbedDocument(docId).catch(() => {
    /* status is set to 'error' inside reEmbedDocument */
  });
  return NextResponse.json({ ok: true, status: "processing" });
}
