import { NextRequest, NextResponse } from "next/server";
import { requireCoach } from "@/lib/guard";
import { duplicateTemplateForCoach } from "@/lib/db";

function parseId(templateId: string): number | null {
  const id = parseInt(templateId, 10);
  return Number.isFinite(id) ? id : null;
}

/**
 * Duplicate a template the coach can see (a global one or their own) into a new
 * personal, editable copy they own. Returns the new template.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ templateId: string }> }
) {
  const guard = await requireCoach();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  const { templateId } = await params;
  const id = parseId(templateId);
  if (id === null) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const template = await duplicateTemplateForCoach(id, Number(session.user.id));
  if (!template) return NextResponse.json({ error: "Template not found" }, { status: 404 });
  return NextResponse.json({ template });
}
