import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";
import { listRagCategories } from "@/lib/rag-manage";

export async function GET() {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;
  return NextResponse.json({ categories: await listRagCategories() });
}
