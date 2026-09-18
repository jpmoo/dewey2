import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";
import {
  getRagDocumentDetail,
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
    await updateDocumentMeta(docId, { title: body.title, description: body.description });
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
