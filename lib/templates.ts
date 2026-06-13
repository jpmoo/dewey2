/**
 * Persisted shape of a coaching template's canvas. Stored as JSONB on
 * coaching_templates.graph. Deliberately framework-agnostic (not React Flow's
 * node shape) so the storage format is stable.
 */

export interface TemplateNode {
  id: string;
  /** ACTIVITY_TYPES key. */
  activityKey: string;
  /** Display label (defaults to the activity label; editable). */
  label: string;
  position: { x: number; y: number };
  /** Phase this activity belongs to, if grouped. */
  phaseId?: string | null;
  /** Done-state gating: OPEN (self-attest) or REVIEWED (coach approves). */
  gating?: "OPEN" | "REVIEWED";
  /** Coach-authored instructions / prompt shown to the partner. */
  instructions?: string;
  /** What the partner is expected to produce in this activity. */
  artifact?: string;
}

export interface TemplateEdge {
  id: string;
  source: string;
  target: string;
  /** Which side handle each end connects to (e.g. "top", "bottom", "left", "right"). */
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

export interface TemplatePhase {
  id: string;
  name: string;
  /** Display color for the phase grouping on the canvas. */
  color?: string;
  /**
   * Criteria the AI evaluates (and surfaces to the coach) once all of the
   * phase's activities are done, before the coach approves advancement.
   * Distinct from activity done-states.
   */
  exitConditions?: string;
}

// Phase ordering is the array order in TemplateGraph.phases.

export interface TemplateGraph {
  nodes: TemplateNode[];
  edges: TemplateEdge[];
  phases: TemplatePhase[];
}

export const EMPTY_GRAPH: TemplateGraph = { nodes: [], edges: [], phases: [] };

/**
 * Template visibility:
 *   - "global"   — admin-authored, available to every coach (read-only to coaches)
 *   - "personal" — a coach's own template, editable only by its owner
 */
export type TemplateScope = "global" | "personal" | "partnership";

export interface CoachingTemplate {
  id: number;
  name: string;
  description: string | null;
  graph: TemplateGraph;
  scope: TemplateScope;
  /** The coach who owns a personal template; null for global/admin templates. */
  owner_id: number | null;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  /** Soft-delete marker; null when visible. Only ever non-null in admin views. */
  deleted_at: string | null;
  /** Partnership plans only: when the coach accepted the embedded plan (null = pending). */
  accepted_at?: string | null;
  /** Partnership plans only: the activity node the partner is currently on (for progress coloring). */
  current_node_id?: string | null;
  /** Partnership plans only: set when a newer plan superseded this one in the thread. */
  deactivated_at?: string | null;
  /** Partnership plans only: the thread this plan is embedded in. */
  thread_id?: number | null;
}
