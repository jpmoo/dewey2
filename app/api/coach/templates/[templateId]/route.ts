import { NextRequest, NextResponse } from "next/server";
import { requireCoach } from "@/lib/guard";
import {
  deleteCoachTemplate,
  getTemplateForCoach,
  logUserEvent,
  updateCoachTemplate,
} from "@/lib/db";
import { logThreadEvent } from "@/lib/messages";
import type { TemplateGraph } from "@/lib/templates";

function parseId(templateId: string): number | null {
  const id = parseInt(templateId, 10);
  return Number.isFinite(id) ? id : null;
}

function sanitizeGraph(g: unknown): TemplateGraph | undefined {
  if (typeof g !== "object" || g === null) return undefined;
  const obj = g as Record<string, unknown>;
  return {
    nodes: Array.isArray(obj.nodes) ? obj.nodes : [],
    edges: Array.isArray(obj.edges) ? obj.edges : [],
    phases: Array.isArray(obj.phases) ? obj.phases : [],
  } as TemplateGraph;
}

/** Load a template visible to the coach (own personal, or any global). */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ templateId: string }> }
) {
  const guard = await requireCoach();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  const { templateId } = await params;
  const id = parseId(templateId);
  if (id === null) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  const template = await getTemplateForCoach(id, Number(session.user.id));
  if (!template) return NextResponse.json({ error: "Plan not found" }, { status: 404 });
  return NextResponse.json({ template });
}

/** Update the coach's own personal template. Global templates are read-only. */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ templateId: string }> }
) {
  const guard = await requireCoach();
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

  const coachId = Number(session.user.id);
  const template = await updateCoachTemplate(id, coachId, update);
  if (!template) {
    return NextResponse.json(
      { error: "Plan not found, or it isn't yours to edit" },
      { status: 404 }
    );
  }
  await logUserEvent({
    userId: coachId,
    actorId: coachId,
    action: "template_updated",
    entityType: "template",
    entityId: template.id,
    entityLabel: template.name,
  });
  // Partnership-plan edits also surface in the partnership thread's log.
  if (template.thread_id != null) {
    await logThreadEvent({
      userId: coachId,
      actorId: coachId,
      action: "plan_edited",
      threadId: template.thread_id,
      detail: template.name,
    });
  }
  return NextResponse.json({ template });
}

/** Delete the coach's own personal template. */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ templateId: string }> }
) {
  const guard = await requireCoach();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  const { templateId } = await params;
  const id = parseId(templateId);
  if (id === null) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  const coachId = Number(session.user.id);
  const existing = await getTemplateForCoach(id, coachId);
  const ok = await deleteCoachTemplate(id, coachId);
  if (!ok) {
    return NextResponse.json(
      { error: "Plan not found, or it isn't yours to delete" },
      { status: 404 }
    );
  }
  await logUserEvent({
    userId: coachId,
    actorId: coachId,
    action: "template_deleted",
    detail: existing?.name ?? undefined,
    entityType: "template",
    entityId: id,
    entityLabel: existing?.name ?? null,
  });
  return NextResponse.json({ ok: true });
}
