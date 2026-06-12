import { NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import { listThreadsForUser } from "@/lib/messages";

/** Threads the user participates in. Admins see every thread (oversight). */
export async function GET() {
  const guard = await requireUser();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  const isAdmin = session.user.system_role === "admin";
  const threads = await listThreadsForUser(Number(session.user.id), isAdmin);
  return NextResponse.json({ threads, isAdmin });
}
