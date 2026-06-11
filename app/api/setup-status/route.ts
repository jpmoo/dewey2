import { NextResponse } from "next/server";
import { hasAdmin } from "@/lib/db";

// Reflects live DB state on every request — never cache.
export const dynamic = "force-dynamic";

/**
 * Whether a dedicated admin account exists. When false the app is in first-run
 * state and every entry point should funnel to /setup.
 */
export async function GET() {
  try {
    const adminExists = await hasAdmin();
    return NextResponse.json({ adminExists, isFirstRun: !adminExists });
  } catch (e) {
    console.error("[setup-status]", e);
    return NextResponse.json(
      { adminExists: false, isFirstRun: true, error: "Database unavailable" },
      { status: 503 }
    );
  }
}
