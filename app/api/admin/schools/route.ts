import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";
import { createSchool } from "@/lib/db";

export async function POST(request: NextRequest) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;
  const body = await request.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const districtId =
    typeof body.district_id === "number"
      ? body.district_id
      : Number.isFinite(Number(body.district_id))
      ? Number(body.district_id)
      : null;
  if (!name) return NextResponse.json({ error: "School name is required" }, { status: 400 });
  if (districtId === null)
    return NextResponse.json({ error: "A district is required" }, { status: 400 });
  try {
    const school = await createSchool(districtId, name);
    return NextResponse.json({ school });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to create school";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
