import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import { markCelebrationsSeen } from "@/lib/messages";

/** Mark completion notes as celebrated for the signed-in user. */
export async function POST(request: NextRequest) {
  const guard = await requireUser();
  if (guard instanceof NextResponse) return guard;
  const body = await request.json().catch(() => ({}));
  const ids = Array.isArray(body.ids)
    ? body.ids.map((n: unknown) => Number(n)).filter((n: number) => Number.isFinite(n))
    : [];
  await markCelebrationsSeen(Number(guard.session.user.id), ids);
  return NextResponse.json({ ok: true });
}
