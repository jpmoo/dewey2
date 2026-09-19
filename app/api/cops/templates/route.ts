import { NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import { getTemplates } from "@/lib/db";

/**
 * Global (shared) plan templates a CoP Chair can assign as the community's arc.
 * Chairs may be any role, so this is available to any authenticated user but only
 * exposes global templates (never anyone's personal drafts).
 */
export async function GET() {
  const guard = await requireUser();
  if (guard instanceof NextResponse) return guard;
  const templates = await getTemplates();
  return NextResponse.json({ templates });
}
