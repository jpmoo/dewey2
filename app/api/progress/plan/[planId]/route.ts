import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import { getProgressPlan } from "@/lib/progress";

/**
 * Restricted plan view for the Progress report — graph + current activity only,
 * never submissions/feedback/conversation. Authorized inside getProgressPlan.
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

  const template = await getProgressPlan(Number(session.user.id), id);
  if (!template) return NextResponse.json({ error: "Plan not found" }, { status: 404 });
  return NextResponse.json({ template });
}
