import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import { getSchools, logUserEvent } from "@/lib/db";
import { getSystemSettings, copCreateLevels } from "@/lib/settings";
import { createCoP, logThreadEvent } from "@/lib/messages";

/** Create a Community of Practice (per-role CoP-creation permissions). */
export async function POST(request: NextRequest) {
  const guard = await requireUser();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  const me = Number(session.user.id);
  const role = session.user.system_role;

  const body = await request.json().catch(() => ({}));
  const subject = typeof body.subject === "string" ? body.subject.trim() : "";
  const goal = typeof body.goal === "string" ? body.goal.trim() : "";
  const chairId = Number(body.chairId);
  const anchorLevel = body.anchorLevel === "school" ? "school" : "district";
  const memberIds = Array.isArray(body.memberIds)
    ? body.memberIds.map((v: unknown) => Number(v)).filter((n: number) => Number.isFinite(n))
    : [];

  if (!subject) return NextResponse.json({ error: "Give the community a name." }, { status: 400 });
  if (!goal) return NextResponse.json({ error: "State the community's goal or problem of practice." }, { status: 400 });
  if (!Number.isFinite(chairId)) return NextResponse.json({ error: "Choose a Chair." }, { status: 400 });

  // Per-role permission for this anchor level.
  const settings = await getSystemSettings();
  const levels = copCreateLevels(role, settings.cop_create_permissions);
  if (!levels.school && !levels.district) {
    return NextResponse.json({ error: "You don't have permission to create communities." }, { status: 403 });
  }
  if (!levels[anchorLevel]) {
    return NextResponse.json(
      { error: `You can't create ${anchorLevel}-wide communities.` },
      { status: 403 }
    );
  }

  // Resolve the anchor. A school anchor also fixes the district (its parent) so
  // the RAG inheritance chain is correct.
  let districtId: number | null = null;
  let schoolId: number | null = null;
  if (anchorLevel === "school") {
    schoolId = Number(body.schoolId);
    if (!Number.isFinite(schoolId)) return NextResponse.json({ error: "Choose a school to anchor to." }, { status: 400 });
    const school = (await getSchools()).find((s) => s.id === schoolId);
    if (!school) return NextResponse.json({ error: "Unknown school." }, { status: 400 });
    districtId = school.district_id;
  } else {
    districtId = Number(body.districtId);
    if (!Number.isFinite(districtId)) return NextResponse.json({ error: "Choose a district to anchor to." }, { status: 400 });
  }

  // A CoP is more than two people; the Chair must be one of the members.
  const members = Array.from(new Set([me, chairId, ...memberIds]));
  if (members.length < 3) {
    return NextResponse.json({ error: "A Community of Practice needs at least three members." }, { status: 400 });
  }
  if (!members.includes(chairId)) {
    return NextResponse.json({ error: "The Chair must be a member of the community." }, { status: 400 });
  }

  try {
    const threadId = await createCoP({
      subject,
      goal,
      chairId,
      memberIds,
      districtId,
      schoolId,
      createdBy: me,
    });
    await logThreadEvent({ userId: me, actorId: me, action: "cop_created", threadId, detail: subject });
    await logUserEvent({ userId: me, actorId: me, action: "cop_created", entityType: "message", entityId: threadId, entityLabel: subject });
    return NextResponse.json({ ok: true, threadId });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to create community" }, { status: 500 });
  }
}
