import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";
import { listCoPs } from "@/lib/messages";

/** List Communities of Practice for the document placement picker (system admin). */
export async function GET() {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;
  const cops = await listCoPs();
  return NextResponse.json({ cops });
}
