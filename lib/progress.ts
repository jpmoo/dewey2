/**
 * The school "Progress" report: for each coachable person in a building, their
 * unarchived conversations with a status dot, plan link, and average per-activity
 * time. Visibility is scoped by the viewer's role (see visibleRolesFor).
 *
 * Timing rule (from product): a conversation's status and the average-days metric
 * count only "partner-court" time — the clock pauses while a submission is waiting
 * on the coach (review/feedback), and resumes when the coach returns it.
 */
import { getPool } from "@/lib/pg";
import {
  ensureSchema,
  getTemplate,
  getUserById,
  PARTNER_ROLES,
  PROGRESS_ROLES,
  type SystemRole,
} from "@/lib/db";
import type { CoachingTemplate, TemplateGraph } from "@/lib/templates";

const DAY = 86_400_000;

export type ProgressDot = "gray" | "green" | "yellow" | "red";

export interface ConvProgress {
  threadId: number;
  threadName: string;
  planId: number | null;
  planName: string | null;
  planDescription: string | null;
  status: ProgressDot;
  complete: boolean;
  currentActivityLabel: string | null;
  avgDaysToComplete: number | null;
}
export interface PartnerProgress {
  userId: number;
  fullName: string;
  username: string;
  role: SystemRole;
  overall: ProgressDot;
  allComplete: boolean;
  conversations: ConvProgress[];
}
export interface ProgressBuilding {
  id: number;
  name: string;
  districtName?: string | null;
}
export interface ProgressReport {
  canAccess: boolean;
  buildings: ProgressBuilding[];
  buildingId: number | null;
  partners: PartnerProgress[];
}

interface SubRow {
  node_id: string;
  status: string;
  created: number;
  decided: number | null;
}

function ms(v: unknown): number | null {
  if (v == null) return null;
  const t = v instanceof Date ? v.getTime() : new Date(v as string).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Total time (ms) the ball was in the partner's court between `t0` and the end of
 * the given submissions. Each submission pauses the clock (partner answered); a
 * "returned" decision resumes it; a still-open interval runs to `nowMs`.
 */
function partnerCourtMs(t0: number, subs: SubRow[], nowMs: number): number {
  let total = 0;
  let start: number | null = t0;
  for (const s of subs) {
    if (start != null) {
      total += Math.max(0, s.created - start);
      start = null; // partner submitted → paused (waiting on coach)
    }
    if (s.status === "returned" && s.decided != null) start = s.decided; // resume
    // pending / approved → stays paused
  }
  if (start != null) total += Math.max(0, nowMs - start);
  return total;
}

function dotFromDays(days: number): ProgressDot {
  if (days < 3) return "green";
  if (days <= 5) return "yellow";
  return "red";
}

/** Worst-of aggregation; a completed plan counts as green. */
function overallDot(convs: ConvProgress[]): ProgressDot {
  let sawGreen = false;
  let sawYellow = false;
  for (const c of convs) {
    const d = c.complete ? "green" : c.status;
    if (d === "red") return "red";
    if (d === "yellow") sawYellow = true;
    if (d === "green") sawGreen = true;
  }
  if (sawYellow) return "yellow";
  if (sawGreen) return "green";
  return "gray";
}

/** Average partner-court days across the plan's completed (approved) activities. */
function avgDaysToComplete(acceptedAt: number | null, subs: SubRow[]): number | null {
  const approved = subs
    .filter((s) => s.status === "approved" && s.decided != null)
    .sort((a, b) => (a.decided as number) - (b.decided as number));
  if (approved.length === 0 || acceptedAt == null) return null;
  const durations: number[] = [];
  for (let k = 0; k < approved.length; k++) {
    const t0 = k === 0 ? acceptedAt : (approved[k - 1].decided as number);
    const nodeSubs = subs
      .filter((s) => s.node_id === approved[k].node_id)
      .sort((a, b) => a.created - b.created);
    durations.push(partnerCourtMs(t0, nodeSubs, approved[k].decided as number) / DAY);
  }
  const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
  return Math.round(avg * 10) / 10;
}

/** Which coachable roles a viewer may see rows for. Deputy also sees only self among leaders. */
function visibleRolesFor(role: SystemRole): SystemRole[] {
  if (role === "coach") return ["partner"];
  if (role === "deputy_site_leader") return ["partner"]; // + self, handled separately
  return [...PARTNER_ROLES]; // site_leader, admin → everyone coachable
}

async function accessibleBuildings(viewer: {
  system_role: SystemRole;
  school_ids: number[];
  district_id: number | null;
}): Promise<ProgressBuilding[]> {
  const pool = getPool();
  if (viewer.system_role === "admin") {
    const res = await pool.query(
      `SELECT s.id, s.name, d.name AS district_name
         FROM schools s LEFT JOIN districts d ON d.id = s.district_id
        WHERE s.deleted_at IS NULL ORDER BY d.name NULLS FIRST, s.name`
    );
    return res.rows.map((r) => ({ id: r.id as number, name: r.name as string, districtName: r.district_name as string | null }));
  }
  if (viewer.school_ids.length > 0) {
    const res = await pool.query(
      `SELECT id, name FROM schools WHERE id = ANY($1::int[]) AND deleted_at IS NULL ORDER BY name`,
      [viewer.school_ids]
    );
    return res.rows.map((r) => ({ id: r.id as number, name: r.name as string }));
  }
  // District-wide coach (no specific building) → every building in the district.
  if (viewer.district_id != null) {
    const res = await pool.query(
      `SELECT id, name FROM schools WHERE district_id = $1 AND deleted_at IS NULL ORDER BY name`,
      [viewer.district_id]
    );
    return res.rows.map((r) => ({ id: r.id as number, name: r.name as string }));
  }
  return [];
}

/** Coachable users in a building visible to the viewer (role-scoped). */
async function visibleUsersInBuilding(
  viewer: { id: number; system_role: SystemRole; school_ids: number[]; full_name: string; username: string },
  buildingId: number
): Promise<{ id: number; full_name: string; username: string; system_role: SystemRole }[]> {
  const pool = getPool();
  const roles = visibleRolesFor(viewer.system_role);
  const res = await pool.query(
    `SELECT u.id, u.full_name, u.username, u.system_role
       FROM users u
       JOIN user_schools us ON us.user_id = u.id AND us.school_id = $1
      WHERE u.deleted_at IS NULL AND u.system_role = ANY($2::text[])
      ORDER BY u.full_name`,
    [buildingId, roles]
  );
  const out = res.rows.map((r) => ({
    id: r.id as number,
    full_name: r.full_name as string,
    username: r.username as string,
    system_role: r.system_role as SystemRole,
  }));
  // A Deputy Site Leader also sees their own row (among leaders, only themselves).
  if (
    viewer.system_role === "deputy_site_leader" &&
    viewer.school_ids.includes(buildingId) &&
    !out.some((u) => u.id === viewer.id)
  ) {
    out.unshift({ id: viewer.id, full_name: viewer.full_name, username: viewer.username, system_role: viewer.system_role });
    out.sort((a, b) => a.full_name.localeCompare(b.full_name));
  }
  return out;
}

async function conversationsFor(userIds: number[]): Promise<Map<number, ConvProgress[]>> {
  const result = new Map<number, ConvProgress[]>();
  if (userIds.length === 0) return result;
  const pool = getPool();
  // Unarchived threads each user participates in, with their latest active/finished plan.
  const threadRes = await pool.query(
    `SELECT p.user_id, t.id AS thread_id, t.subject,
            ap.id AS plan_id, ap.name AS plan_name, ap.description AS plan_desc,
            ap.graph, ap.current_node_id, ap.outcome, ap.accepted_at
       FROM message_threads t
       JOIN thread_participants p ON p.thread_id = t.id AND p.user_id = ANY($1::int[])
       LEFT JOIN LATERAL (
         SELECT cp.id, cp.name, cp.description, cp.graph, cp.current_node_id, cp.outcome, cp.accepted_at
           FROM coaching_templates cp
          WHERE cp.thread_id = t.id AND cp.scope = 'partnership' AND cp.deleted_at IS NULL
            AND cp.accepted_at IS NOT NULL AND cp.deactivated_at IS NULL
          ORDER BY cp.accepted_at DESC LIMIT 1
       ) ap ON TRUE
      WHERE t.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM thread_archived a WHERE a.thread_id = t.id AND a.user_id = p.user_id)
        AND NOT (t.kind = 'partnership' AND COALESCE(t.status, 'open') IN ('done', 'abandoned'))
      ORDER BY t.id DESC`,
    [userIds]
  );

  const planIds = Array.from(
    new Set(threadRes.rows.map((r) => r.plan_id as number | null).filter((v): v is number => v != null))
  );
  const subsByPlan = new Map<number, SubRow[]>();
  if (planIds.length > 0) {
    const subRes = await pool.query(
      `SELECT plan_id, node_id, status, created_at, decided_at
         FROM activity_submissions WHERE plan_id = ANY($1::int[])`,
      [planIds]
    );
    for (const r of subRes.rows) {
      const arr = subsByPlan.get(r.plan_id as number) ?? [];
      arr.push({
        node_id: r.node_id as string,
        status: r.status as string,
        created: ms(r.created_at) ?? 0,
        decided: ms(r.decided_at),
      });
      subsByPlan.set(r.plan_id as number, arr);
    }
  }

  const now = Date.now();
  for (const r of threadRes.rows) {
    const uid = r.user_id as number;
    const arr = result.get(uid) ?? [];
    const threadName = (r.subject as string | null)?.trim() || "Conversation";
    const planId = r.plan_id as number | null;
    const outcome = r.outcome as string | null;

    // No active/finished plan (or an abandoned one) → an open conversation.
    if (planId == null || outcome === "abandoned") {
      arr.push({
        threadId: r.thread_id as number,
        threadName,
        planId: null,
        planName: null,
        planDescription: null,
        status: "gray",
        complete: false,
        currentActivityLabel: null,
        avgDaysToComplete: null,
      });
      result.set(uid, arr);
      continue;
    }

    const graph = (r.graph as TemplateGraph) ?? { nodes: [], edges: [], phases: [] };
    const subs = subsByPlan.get(planId) ?? [];
    const acceptedAt = ms(r.accepted_at);
    const avg = avgDaysToComplete(acceptedAt, subs);
    const base = {
      threadId: r.thread_id as number,
      threadName,
      planId,
      planName: (r.plan_name as string | null) ?? "Plan",
      planDescription: (r.plan_desc as string | null) ?? null,
      avgDaysToComplete: avg,
    };

    if (outcome === "finished") {
      arr.push({ ...base, status: "green", complete: true, currentActivityLabel: null });
      result.set(uid, arr);
      continue;
    }

    // Active plan → status from the current activity's partner-court time.
    const currentId = r.current_node_id as string | null;
    const node = (graph.nodes ?? []).find((n) => n.id === currentId);
    const lastApproved = subs
      .filter((s) => s.status === "approved" && s.decided != null)
      .reduce<number | null>((mx, s) => Math.max(mx ?? 0, s.decided as number), null);
    const t0 = lastApproved ?? acceptedAt ?? now;
    const currentSubs = subs.filter((s) => s.node_id === currentId).sort((a, b) => a.created - b.created);
    const days = partnerCourtMs(t0, currentSubs, now) / DAY;
    arr.push({
      ...base,
      status: currentId ? dotFromDays(days) : "green",
      complete: false,
      currentActivityLabel: node?.label ?? null,
    });
    result.set(uid, arr);
  }
  return result;
}

export async function getProgressReport(
  viewerId: number,
  requestedBuildingId?: number | null
): Promise<ProgressReport> {
  await ensureSchema();
  const viewer = await getUserById(viewerId);
  if (!viewer || !PROGRESS_ROLES.includes(viewer.system_role)) {
    return { canAccess: false, buildings: [], buildingId: null, partners: [] };
  }
  const buildings = await accessibleBuildings(viewer);
  if (buildings.length === 0) {
    return { canAccess: true, buildings: [], buildingId: null, partners: [] };
  }
  const buildingId =
    requestedBuildingId != null && buildings.some((b) => b.id === requestedBuildingId)
      ? requestedBuildingId
      : buildings[0].id;

  const users = await visibleUsersInBuilding(viewer, buildingId);
  const convMap = await conversationsFor(users.map((u) => u.id));
  const partners: PartnerProgress[] = users.map((u) => {
    const conversations = convMap.get(u.id) ?? [];
    return {
      userId: u.id,
      fullName: u.full_name,
      username: u.username,
      role: u.system_role,
      overall: overallDot(conversations),
      allComplete: conversations.length > 0 && conversations.every((c) => c.complete),
      conversations,
    };
  });
  return { canAccess: true, buildings, buildingId, partners };
}

/**
 * Restricted plan view for the Progress report: the plan graph + current activity
 * only — never submissions, feedback, or the conversation. Authorized when the
 * plan's partner is someone the viewer may see in an accessible building.
 */
export async function getProgressPlan(
  viewerId: number,
  planId: number
): Promise<CoachingTemplate | null> {
  await ensureSchema();
  const viewer = await getUserById(viewerId);
  if (!viewer || !PROGRESS_ROLES.includes(viewer.system_role)) return null;
  const pool = getPool();
  const planRes = await pool.query(
    `SELECT id, thread_id FROM coaching_templates
      WHERE id = $1 AND scope = 'partnership' AND deleted_at IS NULL`,
    [planId]
  );
  const plan = planRes.rows[0];
  if (!plan) return null;

  // Authorize: some coachable participant of the plan's thread is visible to the
  // viewer (shares an accessible building and passes the role scope).
  const buildings = await accessibleBuildings(viewer);
  const buildingIds = new Set(buildings.map((b) => b.id));
  const roles = visibleRolesFor(viewer.system_role);
  const partRes = await pool.query(
    `SELECT DISTINCT u.id, u.system_role,
            COALESCE(array_agg(us.school_id) FILTER (WHERE us.school_id IS NOT NULL), '{}') AS school_ids
       FROM thread_participants p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN user_schools us ON us.user_id = u.id
      WHERE p.thread_id = $1 AND u.deleted_at IS NULL
      GROUP BY u.id`,
    [plan.thread_id]
  );
  const allowed = partRes.rows.some((r) => {
    const isSelf = (r.id as number) === viewerId;
    const roleOk = roles.includes(r.system_role as SystemRole) || (viewer.system_role === "deputy_site_leader" && isSelf);
    const sharesBuilding = ((r.school_ids as number[]) ?? []).some((s) => buildingIds.has(s));
    return roleOk && sharesBuilding;
  });
  if (!allowed) return null;
  // The full template (graph + current_node_id + accepted_at drive the current-
  // activity highlight in the read-only viewer). No submissions are included.
  return getTemplate(planId);
}
