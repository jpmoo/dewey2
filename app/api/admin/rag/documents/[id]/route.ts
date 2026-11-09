import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";
import { ragAvailable } from "@/lib/db";
import { getPool } from "@/lib/pg";
import {
  getRagDocumentDetail,
  reEmbedDocument,
  setDocumentCategories,
  softDeleteDocument,
  updateDocumentMeta,
} from "@/lib/rag-manage";

async function id(params: Promise<{ id: string }>): Promise<number | null> {
  const n = parseInt((await params).id, 10);
  return Number.isFinite(n) ? n : null;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;
  const docId = await id(params);
  if (docId == null) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  const doc = await getRagDocumentDetail(docId);
  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ document: doc });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;
  const docId = await id(params);
  if (docId == null) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  const body = await request.json().catch(() => ({}));
  if (typeof body.title === "string" || typeof body.description === "string") {
    const changed = await updateDocumentMeta(docId, { title: body.title, description: body.description });
    // Title and description are embedded with every sample, so re-embed in the
    // background (keeping the stored context headers) when either changes.
    if (changed && (await ragAvailable())) {
      await getPool().query(
        "UPDATE rag_documents SET status = 'processing', status_detail = 'Queued…' WHERE id = $1",
        [docId]
      );
      void reEmbedDocument(docId, { keepContext: true }).catch(() => {
        /* status is set to 'error' inside reEmbedDocument */
      });
    }
  }
  if (Array.isArray(body.categoryIds)) {
    await setDocumentCategories(docId, body.categoryIds.map((n: unknown) => Number(n)).filter(Number.isFinite));
  }
  return NextResponse.json({ document: await getRagDocumentDetail(docId) });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;
  const docId = await id(params);
  if (docId == null) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  await softDeleteDocument(docId);
  return NextResponse.json({ ok: true });
}
