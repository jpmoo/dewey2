import { NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import { getSystemSettings, copCreateLevels } from "@/lib/settings";

/** Whether the current user may create a CoP, and at which anchor levels. */
export async function GET() {
  const guard = await requireUser();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  const settings = await getSystemSettings();
  const levels = copCreateLevels(session.user.system_role, settings.cop_create_permissions);
  return NextResponse.json({ canCreate: levels.school || levels.district, levels });
}
