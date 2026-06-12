import { NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import { warmCoachingModel } from "@/lib/ai";

/**
 * Pre-load the coaching + compliance models (Ollama) so the first AI call —
 * the plan assistant or @dewey in a message — is warm. Any signed-in user may
 * trigger it (best-effort warmup, no data exposure).
 */
export async function POST() {
  const guard = await requireUser();
  if (guard instanceof NextResponse) return guard;
  const result = await warmCoachingModel();
  return NextResponse.json(result);
}
