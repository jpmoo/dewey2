import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";
import { deleteTemplate, getTemplate, logUserEvent, updateTemplate } from "@/lib/db";
import type { TemplateGraph } from "@/lib/templates";

function parseId(templateId: string): number | null {
  const id = parseInt(templateId, 10);
  return Number.isFinite(id) ? id : null;
}

/** Light validation/normalization of an incoming canvas graph. */
function sanitizeGraph(g: unknown): TemplateGraph | undefined {
  if (typeof g !== "object" || g === null) return undefined;
  const obj = g as Record<string, unknown>;
  const nodes = Array.isArray(obj.nodes) ? obj.nodes : [];
  const edges = Array.isArray(obj.edges) ? obj.edges : [];
  const phases = Array.isArray(obj.phases) ? obj.phases : [];
  return { nodes, edges, phases } as TemplateGraph;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ templateId: string }> }
) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;
  const { templateId } = await params;
  const id = parseId(templateId);
  if (id === null) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  const template = await getTemplate(id);
  if (!template) return NextResponse.json({ error: "Plan not found" }, { status: 404 });
  return NextResponse.json({ template });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ templateId: string }> }
) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  const { templateId } = await params;
  const id = parseId(templateId);
  if (id === null) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const body = await request.json().catch(() => ({}));
  const update: { name?: string; description?: string | null; graph?: TemplateGraph } = {};
  if (typeof body.name === "string") update.name = body.name;
  if ("description" in body)
    update.description = body.description == null ? null : String(body.description);
  if ("graph" in body) {
    const g = sanitizeGraph(body.graph);
    if (g) update.graph = g;
  }

  const template = await updateTemplate(id, update);
  if (!template) return NextResponse.json({ error: "Plan not found" }, { status: 404 });
  const adminId = Number(session.user.id);
  await logUserEvent({
    userId: adminId,
    actorId: adminId,
    action: "template_updated",
    entityType: "template",
    entityId: template.id,
    entityLabel: template.name,
  });
  return NextResponse.json({ template });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ templateId: string }> }
) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  const { templateId } = await params;
  const id = parseId(templateId);
  if (id === null) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  const existing = await getTemplate(id);
  const ok = await deleteTemplate(id);
  if (!ok) return NextResponse.json({ error: "Plan not found" }, { status: 404 });
  const adminId = Number(session.user.id);
  await logUserEvent({
    userId: adminId,
    actorId: adminId,
    action: "template_deleted",
    detail: existing?.name ?? undefined,
    entityType: "template",
    entityId: id,
    entityLabel: existing?.name ?? null,
  });
  return NextResponse.json({ ok: true });
}
