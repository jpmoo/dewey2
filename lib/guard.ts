import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import type { Session } from "next-auth";
import { authOptions, isAdminSession } from "@/lib/auth";

/**
 * Guard for admin-only API routes. Returns the session on success, or a ready
 * NextResponse (401/403) to return directly. Usage:
 *
 *   const guard = await requireAdmin();
 *   if (guard instanceof NextResponse) return guard;
 *   const { session } = guard;
 */
export async function requireAdmin(): Promise<{ session: Session } | NextResponse> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isAdminSession(session)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return { session };
}

/**
 * Guard for coach-only API routes. The effective role is the session's
 * system_role, so an admin impersonating a coach passes (they're acting as one).
 */
export async function requireCoach(): Promise<{ session: Session } | NextResponse> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Coach-family: coach + district leader (a coach at their base).
  const role = session.user.system_role;
  if (role !== "coach" && role !== "district_leader") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return { session };
}

/** Guard for shared AI/util routes usable by either a coach or the admin. */
export async function requireCoachOrAdmin(): Promise<{ session: Session } | NextResponse> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const role = session.user.system_role;
  if (role !== "coach" && role !== "admin" && role !== "district_leader") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return { session };
}

/**
 * Message-area authorization scope for a session:
 *   - admin → system-wide oversight
 *   - district_leader → oversight of threads involving their own district
 *   - everyone else → their own threads only
 * `canOversee` is true for admin or district leader (admin-like capabilities in
 * the message area).
 */
export function messageScope(session: Session): {
  me: number;
  isAdmin: boolean;
  overseeDistrictId: number | null;
  canOversee: boolean;
} {
  const role = session.user.system_role;
  const isAdmin = role === "admin";
  const overseeDistrictId =
    role === "district_leader" ? session.user.district_id ?? null : null;
  return { me: Number(session.user.id), isAdmin, overseeDistrictId, canOversee: isAdmin || overseeDistrictId != null };
}

/** Guard for any authenticated user (e.g. the message center). */
export async function requireUser(): Promise<{ session: Session } | NextResponse> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return { session };
}
