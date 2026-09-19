import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";
import { getMessageRecipients, getUserById } from "@/lib/db";
import { getSystemSettings } from "@/lib/settings";
import type { MessagePermissions } from "@/lib/settings";

/**
 * Test the messaging permissions: given a user (any role) and a permission set
 * (the on-screen draft, or the saved one), return who that user could start a
 * conversation with. Lets an admin verify the effect of the settings per role.
 */
export async function POST(request: NextRequest) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;

  const body = await request.json().catch(() => ({}));
  const userId = Number(body.userId);
  if (!Number.isFinite(userId)) return NextResponse.json({ error: "Choose a user" }, { status: 400 });

  const user = await getUserById(userId);
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  // Use the supplied (draft) permissions if present, else the saved ones.
  let perms: MessagePermissions | undefined;
  if (body.message_permissions && typeof body.message_permissions === "object") {
    perms = body.message_permissions as MessagePermissions;
  } else {
    perms = (await getSystemSettings()).message_permissions;
  }

  const recipients = await getMessageRecipients(userId, perms);
  return NextResponse.json({
    user: { id: user.id, full_name: user.full_name, system_role: user.system_role },
    recipients: recipients.map((r) => ({
      id: r.id,
      full_name: r.full_name,
      system_role: r.system_role,
      district_name: r.district_name,
      school_names: r.school_names,
    })),
  });
}
