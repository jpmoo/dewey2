import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";
import { ragAvailable, logUserEvent } from "@/lib/db";
import { ingestDocument, type RagPlacement } from "@/lib/rag-ingest";
import { listRagDocuments } from "@/lib/rag-manage";

/** List the RAG document library (system admin). Optional ?q= search. */
export async function GET(request: NextRequest) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;
  const q = new URL(request.url).searchParams.get("q") ?? "";
  const documents = await listRagDocuments(q);
  return NextResponse.json({ documents, ragAvailable: await ragAvailable() });
}

const MAX_BYTES = 25 * 1024 * 1024;

/** Ingest a document (multipart: file? + title, description, categoryIds, placements, text?). */
export async function POST(request: NextRequest) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  if (!(await ragAvailable())) {
    return NextResponse.json({ error: "RAG isn't available (pgvector/Ollama not configured)." }, { status: 400 });
  }

  const form = await request.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "Invalid upload" }, { status: 400 });

  const title = String(form.get("title") ?? "").trim();
  const description = String(form.get("description") ?? "").trim();
  const pastedText = String(form.get("text") ?? "").trim();
  const categoryIds = parseNums(form.get("categoryIds"));
  const placements = parsePlacements(form.get("placements"));

  if (placements.length === 0) {
    return NextResponse.json({ error: "Choose at least one place for this document." }, { status: 400 });
  }

  const file = form.get("file");
  let bytes: Buffer | null = null;
  let filename: string | null = null;
  let mime: string | null = null;
  if (file && typeof file !== "string") {
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: "File is too large (25 MB max)." }, { status: 400 });
    }
    bytes = Buffer.from(await file.arrayBuffer());
    filename = file.name;
    mime = file.type || null;
  }
  if (!bytes && !pastedText) {
    return NextResponse.json({ error: "Attach a file or paste some text." }, { status: 400 });
  }

  try {
    const result = await ingestDocument({
      title: title || filename || "Untitled",
      description,
      filename,
      mime,
      bytes,
      extractedText: pastedText || null,
      categoryIds,
      placements,
      uploadedBy: Number(session.user.id),
    });
    await logUserEvent({
      userId: Number(session.user.id),
      actorId: Number(session.user.id),
      action: "rag_document_ingested",
      entityLabel: title || filename || "document",
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Ingest failed" },
      { status: 500 }
    );
  }
}

function parseNums(v: FormDataEntryValue | null): number[] {
  if (typeof v !== "string" || !v) return [];
  try {
    const a = JSON.parse(v);
    return Array.isArray(a) ? a.map((n) => Number(n)).filter((n) => Number.isFinite(n)) : [];
  } catch {
    return [];
  }
}

function parsePlacements(v: FormDataEntryValue | null): RagPlacement[] {
  if (typeof v !== "string" || !v) return [];
  try {
    const a = JSON.parse(v);
    if (!Array.isArray(a)) return [];
    return a
      .filter((p) => p && ["system", "district", "school", "cop"].includes(p.level))
      .map((p) => ({
        level: p.level,
        districtId: p.districtId != null ? Number(p.districtId) : null,
        schoolId: p.schoolId != null ? Number(p.schoolId) : null,
        copId: p.copId != null ? Number(p.copId) : null,
      }));
  } catch {
    return [];
  }
}
