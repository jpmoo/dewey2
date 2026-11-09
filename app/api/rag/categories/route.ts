import { NextResponse } from "next/server";
import { requirePlanAuthor } from "@/lib/guard";
import { listRagCategories } from "@/lib/rag-manage";

/** RAG categories for the plan-builder source selectors (coach/admin/district leader). */
export async function GET() {
  const guard = await requirePlanAuthor();
  if (guard instanceof NextResponse) return guard;
  return NextResponse.json({ categories: await listRagCategories() });
}
