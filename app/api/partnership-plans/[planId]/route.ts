import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import {
  editThreadPlan,
  getApprovedNodeIds,
  getPlanForThreadMember,
  logUserEvent,
} from "@/lib/db";
import type { TemplateGraph } from "@/lib/templates";

/**
 * Read a partnership plan (the embedded copy). Allowed for any participant of
 * the plan's thread (read-only); powers the partner's read-only plan view.
 * Also returns `completedNodeIds` so an editor can lock done activities.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ planId: string }> }
) {
  const guard = await requireUser();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  const { planId } = await params;
  const id = parseInt(planId, 10);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const isAdmin = session.user.system_role === "admin";
  const template = await getPlanForThreadMember(id, Number(session.user.id), isAdmin);
  if (!template) return NextResponse.json({ error: "Plan not found" }, { status: 404 });
  const completedNodeIds = Array.from(await getApprovedNodeIds(id));
  return NextResponse.json({ template, completedNodeIds });
}

/**
 * Edit a partnership plan in place (coach or admin who manages the thread).
 * Completed parts are immutable; the plan returns to "proposed" for re-acceptance.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ planId: string }> }
) {
  const guard = await requireUser();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  const { planId } = await params;
  const id = parseInt(planId, 10);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const body = await request.json().catch(() => ({}));
  const g = body.graph as Partial<TemplateGraph> | undefined;
  if (!g || !Array.isArray(g.nodes)) {
    return NextResponse.json({ error: "A plan graph is required" }, { status: 400 });
  }
  const graph: TemplateGraph = {
    nodes: g.nodes,
    edges: Array.isArray(g.edges) ? g.edges : [],
    phases: Array.isArray(g.phases) ? g.phases : [],
  };
  const me = Number(session.user.id);
  const result = await editThreadPlan(id, me, {
    graph,
    name: typeof body.name === "string" ? body.name : undefined,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  await logUserEvent({
    userId: me,
    actorId: me,
    action: "plan_edited",
    entityType: "template",
    entityId: id,
  });
  return NextResponse.json({ ok: true });
}
