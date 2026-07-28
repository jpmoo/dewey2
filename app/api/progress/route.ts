import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import { getProgressReport } from "@/lib/progress";

/** The school Progress report for the signed-in user (role-scoped). */
export async function GET(request: NextRequest) {
  const guard = await requireUser();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  const url = new URL(request.url);
  const b = Number(url.searchParams.get("buildingId"));
  const buildingId = Number.isFinite(b) && b > 0 ? b : null;

  const report = await getProgressReport(Number(session.user.id), buildingId);
  if (!report.canAccess) {
    return NextResponse.json({ error: "Not available for your role" }, { status: 403 });
  }
  return NextResponse.json(report);
}
