import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";
import { listOpenSubmissions } from "@/lib/messages";

/** Open template submissions awaiting an admin decision. */
export async function GET() {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;
  const submissions = await listOpenSubmissions();
  return NextResponse.json({ submissions });
}
