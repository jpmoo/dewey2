/**
 * Pure traversal helpers over a plan's TemplateGraph, used to advance the active
 * activity as submissions are completed. Plans are effectively linear; where a
 * node has multiple successors we follow the first outgoing edge.
 */
import type { TemplateGraph, TemplateNode } from "@/lib/templates";

export function nodeById(graph: TemplateGraph, nodeId: string): TemplateNode | null {
  return (graph.nodes ?? []).find((n) => n.id === nodeId) ?? null;
}

export function phaseIdOfNode(graph: TemplateGraph, nodeId: string): string | null {
  return nodeById(graph, nodeId)?.phaseId ?? null;
}

/** The activity that follows `nodeId` (first outgoing edge), or null if it's terminal. */
export function nextNodeId(graph: TemplateGraph, nodeId: string): string | null {
  const edge = (graph.edges ?? []).find((e) => e.source === nodeId);
  return edge ? edge.target : null;
}

/**
 * Find the activity a (re-)accepted plan should sit on: walk from the entry node
 * along the flow, skipping any already-done (approved) activities, and return the
 * first not-done node. Returns null when every reachable node is done (→ the plan
 * is finished). Used when a plan is accepted or re-accepted after an in-flight
 * edit, so the partner lands on the right next step regardless of what changed.
 */
export function recomputeCurrent(graph: TemplateGraph, doneNodeIds: Set<string>): string | null {
  const nodes = graph.nodes ?? [];
  if (nodes.length === 0) return null;
  const hasIncoming = new Set((graph.edges ?? []).map((e) => e.target));
  let id: string | null = (nodes.find((n) => !hasIncoming.has(n.id)) ?? nodes[0]).id;
  const seen = new Set<string>();
  while (id && doneNodeIds.has(id) && !seen.has(id)) {
    seen.add(id);
    id = nextNodeId(graph, id);
  }
  return id;
}

/**
 * Whether `nodeId` is the last activity in its phase: it has no successor that
 * sits in the same phase (covers both a phase boundary and the end of the plan).
 */
export function isLastInPhase(graph: TemplateGraph, nodeId: string): boolean {
  const phaseId = phaseIdOfNode(graph, nodeId);
  const successors = (graph.edges ?? [])
    .filter((e) => e.source === nodeId)
    .map((e) => phaseIdOfNode(graph, e.target));
  // No successor at all → last in phase (and plan). Otherwise last-in-phase iff
  // none of the successors share this node's phase.
  if (successors.length === 0) return true;
  return !successors.some((p) => p === phaseId);
}
