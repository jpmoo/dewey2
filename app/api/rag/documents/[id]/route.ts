import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import { getPool } from "@/lib/pg";

/**
 * Serve a RAG source document to an authenticated user for citation links in
 * chat. A user may view a document only when it is placed somewhere in their own
 * org chain — system-wide, their district, one of their schools, or a Community
 * of Practice they belong to — with admins allowed everything. Returns the
 * stored (normalized) file inline, or the extracted text when only text exists.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireUser();
  if (guard instanceof NextResponse) return guard;
  const uid = Number(guard.session.user.id);
  const docId = parseInt((await params).id, 10);
  if (!Number.isFinite(docId)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const pool = getPool();
  const res = await pool.query(
    `SELECT d.bytes, d.mime, d.filename, d.title, d.extracted_text
       FROM rag_documents d
      WHERE d.id = $1 AND d.deleted_at IS NULL
        AND (
          (SELECT system_role FROM users WHERE id = $2) = 'admin'
          OR EXISTS (
            SELECT 1 FROM rag_document_placements pl
             WHERE pl.document_id = d.id AND (
               pl.level = 'system'
               OR (pl.level = 'district' AND pl.district_id = (SELECT district_id FROM users WHERE id = $2))
               OR (pl.level = 'school' AND (
                     pl.school_id IN (SELECT school_id FROM user_schools WHERE user_id = $2)
                     OR pl.school_id = (SELECT school_id FROM users WHERE id = $2)))
               OR (pl.level = 'cop' AND pl.cop_id IN (
                     SELECT thread_id FROM thread_participants WHERE user_id = $2))
             )
          )
        )`,
    [docId, uid]
  );
  const row = res.rows[0];
  // Don't distinguish "missing" from "forbidden" — avoids probing the library.
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const filename = (row.filename as string | null) || `${(row.title as string) || "document"}`;
  const disposition = `inline; filename="${encodeURIComponent(filename)}"`;

  if (row.bytes) {
    return new NextResponse(new Uint8Array(row.bytes as Buffer), {
      status: 200,
      headers: {
        "content-type": (row.mime as string | null) || "application/pdf",
        "content-disposition": disposition,
        "cache-control": "private, no-store",
      },
    });
  }
  const text = (row.extracted_text as string | null) ?? "";
  if (!text) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return new NextResponse(text, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": `inline; filename="${encodeURIComponent(filename)}.txt"`,
      "cache-control": "private, no-store",
    },
  });
}
