import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";
import { createTemplate, getTemplates } from "@/lib/db";

export async function GET() {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;
  const templates = await getTemplates();
  return NextResponse.json({ templates });
}

export async function POST(request: NextRequest) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;

  const body = await request.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "Template name is required" }, { status: 400 });

  const template = await createTemplate({
    name,
    description: typeof body.description === "string" ? body.description : null,
    createdBy: Number(session.user.id),
  });
  return NextResponse.json({ template });
}
