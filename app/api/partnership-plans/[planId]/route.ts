import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import { getPlanForThreadMember } from "@/lib/db";

/**
 * Read a partnership plan (the embedded copy). Allowed for any participant of
 * the plan's thread (read-only); powers the partner's read-only plan view.
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
  return NextResponse.json({ template });
}
