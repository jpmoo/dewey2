import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import { listBackups, runBackup } from "@/lib/backup";
import { getSystemSettings, updateSystemSettings } from "@/lib/settings";

export const runtime = "nodejs";

/** List on-server backups + the retention setting (admin only). */
export async function GET() {
  const guard = await requireUser();
  if (guard instanceof NextResponse) return guard;
  if (guard.session.user.system_role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const [backups, settings] = await Promise.all([listBackups(), getSystemSettings()]);
  return NextResponse.json({ backups, retentionDays: settings.backup_retention_days });
}

/** Update the retention window (days to keep), admin only. */
export async function PATCH(request: NextRequest) {
  const guard = await requireUser();
  if (guard instanceof NextResponse) return guard;
  if (guard.session.user.system_role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = await request.json().catch(() => ({}));
  const days = Number(body.retentionDays);
  if (!Number.isFinite(days) || days < 1) {
    return NextResponse.json({ error: "Invalid retention" }, { status: 400 });
  }
  await updateSystemSettings({ backup_retention_days: days });
  return NextResponse.json({ ok: true, retentionDays: Math.floor(days) });
}

/** Force a fresh backup for today, now (admin only). */
export async function POST() {
  const guard = await requireUser();
  if (guard instanceof NextResponse) return guard;
  if (guard.session.user.system_role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    await runBackup();
    const backups = await listBackups();
    return NextResponse.json({ ok: true, backups });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Backup failed" },
      { status: 500 }
    );
  }
}
