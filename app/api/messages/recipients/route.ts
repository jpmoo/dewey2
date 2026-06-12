import { NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import { getMessageRecipients, type SystemRole } from "@/lib/db";

/** Users the signed-in user may start a new message thread with. */
export async function GET() {
  const guard = await requireUser();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  const recipients = await getMessageRecipients({
    id: Number(session.user.id),
    system_role: session.user.system_role as SystemRole,
  });
  return NextResponse.json({ recipients });
}
