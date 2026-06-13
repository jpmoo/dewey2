import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import { canAccessThread, getActiveActivity, logThreadEvent } from "@/lib/messages";
import { userManagesThreadPlan } from "@/lib/db";
import { consultDeweyOnSubmission } from "@/lib/dewey-review";
import { allowAiRequest } from "@/lib/rate-limit";

/** A coach consults Dewey about the pending submission (persisted). */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ threadId: string }> }
) {
  const guard = await requireUser();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  const { threadId } = await params;
  const id = parseInt(threadId, 10);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const me = Number(session.user.id);
  const isAdmin = session.user.system_role === "admin";
  if (!(await canAccessThread(id, me, isAdmin))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const active = await getActiveActivity(id);
  if (!active || !active.submission) {
    return NextResponse.json({ error: "There is no submission to discuss." }, { status: 400 });
  }
  if (!(await userManagesThreadPlan(active.planId, me))) {
    return NextResponse.json({ error: "Only a coach can consult Dewey here." }, { status: 403 });
  }

  if (!allowAiRequest(me)) {
    return NextResponse.json(
      { error: "You're sending requests too quickly — please wait a moment." },
      { status: 429 }
    );
  }

  const body = await request.json().catch(() => ({}));
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) return NextResponse.json({ error: "Ask Dewey a question." }, { status: 400 });

  try {
    const reply = await consultDeweyOnSubmission({ submissionId: active.submission.id, question });
    await logThreadEvent({ userId: me, actorId: me, action: "activity_consulted", threadId: id });
    return NextResponse.json({ reply });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Dewey couldn't respond.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
