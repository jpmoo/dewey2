import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";
import { createTemplate, getTemplates, logUserEvent } from "@/lib/db";
import type { TemplateGraph } from "@/lib/templates";

export async function GET() {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;
  const templates = await getTemplates();
  return NextResponse.json({ templates });
}

export async function POST(request: NextRequest) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;

  const body = await request.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "Template name is required" }, { status: 400 });

  // Optional initial canvas graph (when creating from the canvas on first save).
  let graph: TemplateGraph | undefined;
  if (body.graph && typeof body.graph === "object") {
    const g = body.graph as Record<string, unknown>;
    graph = {
      nodes: Array.isArray(g.nodes) ? g.nodes : [],
      edges: Array.isArray(g.edges) ? g.edges : [],
      phases: Array.isArray(g.phases) ? g.phases : [],
    } as TemplateGraph;
  }

  const adminId = Number(session.user.id);
  const template = await createTemplate({
    name,
    description: typeof body.description === "string" ? body.description : null,
    graph,
    createdBy: adminId,
  });
  await logUserEvent({
    userId: adminId,
    actorId: adminId,
    action: "template_created",
    entityType: "template",
    entityId: template.id,
    entityLabel: template.name,
  });
  return NextResponse.json({ template });
}
