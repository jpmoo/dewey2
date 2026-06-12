import { NextRequest, NextResponse } from "next/server";
import { requireCoach } from "@/lib/guard";
import { createTemplate, getTemplatesForCoach } from "@/lib/db";
import type { TemplateGraph } from "@/lib/templates";

/** List the coach's own templates plus every global (admin) template. */
export async function GET() {
  const guard = await requireCoach();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  const templates = await getTemplatesForCoach(Number(session.user.id));
  return NextResponse.json({ templates });
}

/** Create a new personal template owned by the coach. */
export async function POST(request: NextRequest) {
  const guard = await requireCoach();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;

  const body = await request.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "Template name is required" }, { status: 400 });

  let graph: TemplateGraph | undefined;
  if (body.graph && typeof body.graph === "object") {
    const g = body.graph as Record<string, unknown>;
    graph = {
      nodes: Array.isArray(g.nodes) ? g.nodes : [],
      edges: Array.isArray(g.edges) ? g.edges : [],
      phases: Array.isArray(g.phases) ? g.phases : [],
    } as TemplateGraph;
  }

  const coachId = Number(session.user.id);
  const template = await createTemplate({
    name,
    description: typeof body.description === "string" ? body.description : null,
    graph,
    createdBy: coachId,
    scope: "personal",
    ownerId: coachId,
  });
  return NextResponse.json({ template });
}
