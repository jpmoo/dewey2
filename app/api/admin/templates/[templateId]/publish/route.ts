import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";
import { publishTemplateAsGlobal, logUserEvent } from "@/lib/db";

/** Publish an admin draft to the global library (no approval needed). Admin only. */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ templateId: string }> }
) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;
  const { templateId } = await params;
  const id = parseInt(templateId, 10);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const template = await publishTemplateAsGlobal(id);
  if (!template) {
    return NextResponse.json({ error: "Not a draft that can be published" }, { status: 400 });
  }
  const adminId = Number(guard.session.user.id);
  await logUserEvent({
    userId: adminId,
    actorId: adminId,
    action: "template_published",
    entityType: "template",
    entityId: template.id,
    entityLabel: template.name,
  });
  return NextResponse.json({ template });
}
