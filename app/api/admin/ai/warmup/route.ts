import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";
import { warmCoachingModel } from "@/lib/ai";

/** Pre-load the coaching model (Ollama) so the first AI call is warm. */
export async function POST() {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;
  const result = await warmCoachingModel();
  return NextResponse.json(result);
}
