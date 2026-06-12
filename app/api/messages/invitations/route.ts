import { NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import { getPendingInvitations } from "@/lib/messages";

/** Pending partnership invitations awaiting the user's yes/no. */
export async function GET() {
  const guard = await requireUser();
  if (guard instanceof NextResponse) return guard;
  const invitations = await getPendingInvitations(Number(guard.session.user.id));
  return NextResponse.json({ invitations });
}
