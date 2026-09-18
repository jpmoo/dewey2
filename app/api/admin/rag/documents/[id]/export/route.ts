import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";
import { exportRagDocumentReport } from "@/lib/rag-manage";

/** Download a plain-text diagnostic report of a document (metadata, full text, chunks). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;
  const docId = parseInt((await params).id, 10);
  if (!Number.isFinite(docId)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const report = await exportRagDocumentReport(docId);
  if (!report) return NextResponse.json({ error: "Document not found" }, { status: 404 });

  return new NextResponse(report.text, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": `attachment; filename="${report.filename}"`,
      "cache-control": "no-store",
    },
  });
}
