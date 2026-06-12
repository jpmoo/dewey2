import { NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import { getMessageRecipients } from "@/lib/db";
import { getSystemSettings } from "@/lib/settings";

/** Users the signed-in user may start a new message thread with. */
export async function GET() {
  const guard = await requireUser();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  const settings = await getSystemSettings();
  const recipients = await getMessageRecipients(
    Number(session.user.id),
    settings.message_permissions
  );
  return NextResponse.json({ recipients });
}
