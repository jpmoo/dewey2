"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  ControlButton,
  ViewportPortal,
  Handle,
  Position,
  MarkerType,
  SelectionMode,
  ConnectionMode,
  addEdge,
  applyNodeChanges,
  getNodesBounds,
  getViewportForBounds,
  useNodesState,
  useEdgesState,
  useNodes,
  useReactFlow,
  type Node,
  type Edge,
  type Connection,
  type NodeProps,
  type NodeChange,
  type ColorMode,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import ReactMarkdown from "react-markdown";
import { apiFetch } from "@/lib/api-client";
import { pathWithBase } from "@/lib/base-path";
import { useDialog } from "@/components/DialogProvider";
import { buildPlanPrintHtml } from "@/lib/plan-print";
import { toPng } from "html-to-image";
import { getHelperLines, HelperLines } from "./helper-lines";

// The v1 "Compliance notice" wording, shown when the screen flags a message.
const COMPLIANCE_NOTICE =
  "The conversation is heading in a direction that may violate specific rules or laws about privacy, or trigger records retention requirements in your organization or locale. Remember that Dewey is only meant to be a reflective partner to push your thinking, not an authority for direct answers—particularly in areas like this. If the question or concern you are raising is a true problem of practice that could benefit from coaching and reflection, try rewording it so that it does not potentially lead the conversation into discussion of confidential or otherwise sensitive details. If you have questions about the appropriateness of the topic for discussion in Dewey, please consult your organization's or your own personal qualified legal counsel.";
import {
  ACTIVITY_TYPES,
  ACTIVITY_BY_KEY,
  CATEGORY_META,
  GATING_LABEL,
  type ActivityCategory,
  type Gating,
} from "@/lib/activities";
import { EMPTY_GRAPH } from "@/lib/templates";
import type { CoachingTemplate, TemplateGraph, TemplatePhase } from "@/lib/templates";

// Colors cycled through as phases are created.
const PHASE_COLORS = ["#2563eb", "#16a34a", "#9333ea", "#ea580c", "#0891b2", "#db2777"];

// The arrowhead sits on the target end (the activity an edge flows into).
const ARROW = { type: MarkerType.ArrowClosed, width: 22, height: 22 } as const;

// Activity nodes use this fixed width so labels wrap predictably and the phase
// cloud (which sizes to node widths) is always wide enough. NODE_H is the
// pre-measurement height fallback for the cloud.
const NODE_W = 184;
const NODE_H = 64;

/**
 * Choose sensible source/target handles for an edge from the two nodes' relative
 * positions: flow out the side that faces the target and in the opposite side
 * (e.g. a node directly below connects bottom→top). Every node exposes top/left/
 * right/bottom handles, so this keeps edges from wrapping around. Explicit
 * handles saved by a user override this.
 */
function pickHandles(
  sp: { x: number; y: number } | undefined,
  tp: { x: number; y: number } | undefined
): { sourceHandle: string; targetHandle: string } {
  if (!sp || !tp) return { sourceHandle: "bottom", targetHandle: "top" };
  const dx = tp.x - sp.x;
  const dy = tp.y - sp.y;
  if (Math.abs(dy) >= Math.abs(dx)) {
    return dy >= 0
      ? { sourceHandle: "bottom", targetHandle: "top" }
      : { sourceHandle: "top", targetHandle: "bottom" };
  }
  return dx >= 0
    ? { sourceHandle: "right", targetHandle: "left" }
    : { sourceHandle: "left", targetHandle: "right" };
}

/** Map graph edges to React Flow edges, filling in geometry-based handles when absent. */
function toFlowEdges(
  edges: { id: string; source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }[],
  posById: Map<string, { x: number; y: number }>
): Edge[] {
  return edges.map((e) => {
    const auto = pickHandles(posById.get(e.source), posById.get(e.target));
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle ?? auto.sourceHandle,
      targetHandle: e.targetHandle ?? auto.targetHandle,
      markerEnd: ARROW,
    };
  });
}

function rgba(hex: string, a: number): string {
  const m = hex.replace("#", "");
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

const CLOUD_PAD = 26;
const CLOUD_LABEL_STRIP = 30;

/**
 * Translucent "cloud" behind each phase, sized to its members' bounding box.
 * Reads live node dimensions from the React Flow store (useNodes), so it sizes
 * to the actual rendered activity sizes — identical in the editor and preview.
 * Must be rendered inside a <ReactFlow>.
 */
function PhaseClouds({
  phases,
  onEditPhase,
  onPhaseInfo,
  onMovePhase,
}: {
  phases: TemplatePhase[];
  onEditPhase?: (id: string) => void;
  /** Read-only: click the phase label to see its details. */
  onPhaseInfo?: (id: string) => void;
  /** Editor: drag the cloud to move the phase and all its activities (flow-space delta). */
  onMovePhase?: (id: string, dx: number, dy: number) => void;
}) {
  const nodes = useNodes();
  const { getViewport } = useReactFlow();
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const clouds = useMemo(() => {
    return phases
      .map((p, idx) => {
        const members = nodes.filter(
          (n) => (n.data as { phaseId?: string | null }).phaseId === p.id
        );
        if (members.length === 0) return null;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const n of members) {
          const w = n.measured?.width ?? NODE_W;
          const h = n.measured?.height ?? NODE_H;
          minX = Math.min(minX, n.position.x);
          minY = Math.min(minY, n.position.y);
          maxX = Math.max(maxX, n.position.x + w);
          maxY = Math.max(maxY, n.position.y + h);
        }
        const color = p.color ?? "#2563eb";
        return {
          id: p.id,
          number: idx + 1,
          name: p.name,
          exitConditions: p.exitConditions ?? "",
          color,
          x: minX - CLOUD_PAD,
          y: minY - CLOUD_PAD - CLOUD_LABEL_STRIP,
          w: maxX - minX + CLOUD_PAD * 2,
          h: maxY - minY + CLOUD_PAD * 2 + CLOUD_LABEL_STRIP,
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);
  }, [phases, nodes]);

  return (
    <ViewportPortal>
      {clouds.map((c) => {
        // Read-only: the whole cloud is clickable for details (pointer events on
        // the cloud — panning still works on empty space outside any cloud).
        // Editor: keep the cloud click-through so nodes stay draggable; only the
        // label double-click edits exit conditions.
        const tip = `Phase: ${c.name}${c.exitConditions ? `\n\nExit conditions: ${c.exitConditions}` : ""}\n\nClick for details`;
        const interactive = !!onPhaseInfo || !!onMovePhase;
        return (
          <div
            key={c.id}
            onClick={onPhaseInfo ? () => onPhaseInfo(c.id) : undefined}
            onPointerDown={
              onMovePhase
                ? (e) => {
                    if (e.button !== 0) return; // left-drag moves the phase
                    e.stopPropagation();
                    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                    dragRef.current = { x: e.clientX, y: e.clientY };
                  }
                : undefined
            }
            onPointerMove={
              onMovePhase
                ? (e) => {
                    if (!dragRef.current) return;
                    const zoom = getViewport().zoom || 1;
                    const dx = (e.clientX - dragRef.current.x) / zoom;
                    const dy = (e.clientY - dragRef.current.y) / zoom;
                    dragRef.current = { x: e.clientX, y: e.clientY };
                    onMovePhase(c.id, dx, dy);
                  }
                : undefined
            }
            onPointerUp={
              onMovePhase
                ? (e) => {
                    dragRef.current = null;
                    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
                  }
                : undefined
            }
            title={onPhaseInfo ? tip : onMovePhase ? "Drag to move this phase and its activities" : undefined}
            style={{
              position: "absolute",
              transform: `translate(${c.x}px, ${c.y}px)`,
              width: c.w,
              height: c.h,
              background: rgba(c.color, 0.1),
              border: `1px solid ${rgba(c.color, 0.4)}`,
              borderRadius: 36,
              boxShadow: `0 2px 18px ${rgba(c.color, 0.12)}`,
              zIndex: -1,
              pointerEvents: interactive ? "auto" : "none",
              cursor: onMovePhase ? "grab" : onPhaseInfo ? "pointer" : "default",
              touchAction: onMovePhase ? "none" : undefined,
            }}
          >
            <span
              onDoubleClick={onEditPhase ? () => onEditPhase(c.id) : undefined}
              title={onEditPhase ? "Double-click to edit phase exit conditions" : undefined}
              style={{
                position: "absolute",
                top: 10,
                left: 20,
                fontSize: 11,
                fontWeight: 600,
                color: c.color,
                cursor: onEditPhase ? "pointer" : "inherit",
                pointerEvents: onEditPhase ? "auto" : "none",
              }}
            >
              {c.number}. {c.name}
            </span>
          </div>
        );
      })}
    </ViewportPortal>
  );
}

type ActivityNodeData = {
  activityKey: string;
  label: string;
  category: ActivityCategory;
  gating: Gating;
  instructions: string;
  artifact: string;
  phaseId?: string | null;
  phaseName?: string | null;
  phaseColor?: string | null;
  /** Progress state for an accepted partnership plan; undefined = no progress overlay. */
  progress?: "completed" | "current" | "upcoming";
  /** Read-only preview: the node is clickable for details (show a pointer cursor). */
  clickable?: boolean;
  /** Order letter within its phase (a, b, c…), shown as a badge and in the print export. */
  letter?: string;
};

// Spreadsheet-style letters: a..z, aa, ab… (matches lib/plan-print).
function orderLetter(i: number): string {
  let s = "";
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(97 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Explicit edge stroke so connections render in exported images (html-to-image
// doesn't carry React Flow's CSS-variable edge color).
const EDGE_STYLE = { stroke: "#94a3b8", strokeWidth: 1.5 } as const;

let idCounter = 0;
function newId(prefix: string): string {
  idCounter += 1;
  // Deterministic-enough for a session; the server doesn't care about the value.
  return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
}

// ---- Custom node ------------------------------------------------------------

function ActivityNode({ data, selected }: NodeProps<Node<ActivityNodeData>>) {
  // The top stripe encodes the activity category; the border/chip reflect the phase.
  const catColor = CATEGORY_META[data.category]?.color ?? "#6b6b6b";
  const description = data.instructions || ACTIVITY_BY_KEY[data.activityKey]?.defaultInstructions || "";
  const artifact = data.artifact || ACTIVITY_BY_KEY[data.activityKey]?.defaultArtifact || "";
  const tip = [description, artifact && `Expected: ${artifact}`].filter(Boolean).join("\n\n");

  // Progress overlay for an accepted partnership plan: the current activity is
  // ringed green; completed activities are grayed/dimmed.
  const isCurrent = data.progress === "current";
  const isCompleted = data.progress === "completed";
  const borderColor = isCurrent ? "#16a34a" : data.phaseColor || catColor;
  const borderWidth = isCurrent ? 3 : selected ? 2 : 1;
  return (
    <div
      className={`rounded-md border shadow-sm text-xs ${
        isCurrent
          ? "bg-green-50 text-green-900"
          : isCompleted
          ? "bg-dewey-surface-2 text-dewey-ink"
          : "bg-dewey-surface text-dewey-ink"
      } ${data.clickable ? "cursor-pointer" : ""}`}
      title={tip || undefined}
      style={{
        borderColor,
        borderWidth,
        width: NODE_W,
        opacity: isCompleted ? 0.55 : 1,
        filter: isCompleted ? "grayscale(1)" : undefined,
      }}
    >
      {/* A handle on every side; all are source-typed but connect both ways in
          loose mode, so you can draw a connection from/to any side, any way. */}
      <Handle type="source" position={Position.Top} id="top" />
      <Handle type="source" position={Position.Left} id="left" />
      <Handle type="source" position={Position.Right} id="right" />
      <div className="h-1 rounded-t" style={{ background: catColor }} />
      <div className="px-2 py-1.5">
        <div className="break-words font-medium leading-tight">
          {data.letter && (
            <span className="mr-1 font-bold" style={{ color: data.phaseColor || catColor }}>
              {data.letter}.
            </span>
          )}
          {data.label}
        </div>
        <div className="mt-0.5 flex items-center gap-1">
          <span className={`text-[10px] ${isCurrent ? "text-green-800" : "text-dewey-mute"}`}>
            {GATING_LABEL[data.gating]}
          </span>
          {isCurrent && (
            <span className="rounded bg-green-600 px-1 text-[9px] font-medium uppercase text-white">
              Current
            </span>
          )}
          {isCompleted && <span className="text-[9px] uppercase text-dewey-mute">✓ done</span>}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} id="bottom" />
    </div>
  );
}

const nodeTypes = { activity: ActivityNode };

// ---- Editor -----------------------------------------------------------------

function CanvasInner({
  template,
  onClose,
  templatesBase,
  lockedNodeIds = [],
}: {
  template: CoachingTemplate;
  onClose: () => void;
  /** CRUD base path: "/api/admin/templates" (admin) or "/api/coach/templates" (coach). */
  templatesBase: string;
  /** Completed activities that can't be edited/deleted (editing an active plan). */
  lockedNodeIds?: string[];
}) {
  const dialog = useDialog();
  // Completed (approved) activity ids, locked from editing. Stateful so "Reset
  // progress" can unlock everything in place after cancelling progress.
  const [lockedSet, setLockedSet] = useState<Set<string>>(() => new Set(lockedNodeIds));
  const wrapperRef = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition, getNodes } = useReactFlow();

  const [name, setName] = useState(template.name);
  const [phases, setPhases] = useState<TemplatePhase[]>(template.graph.phases ?? []);
  const [description, setDescription] = useState(template.description ?? "");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  // Save dialog: prompts for a description (pre-drafted by the summarization model).
  const [saveOpen, setSaveOpen] = useState(false);
  const [descDraft, setDescDraft] = useState("");
  const [descLoading, setDescLoading] = useState(false);
  // null until the template exists in the DB (a "new" template is created on first Save).
  const [savedId, setSavedId] = useState<number | null>(template.id > 0 ? template.id : null);
  // Snapshot of the last-saved state; set on mount and after each save to detect unsaved changes.
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null);
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [editingPhaseId, setEditingPhaseId] = useState<string | null>(null);
  const [dragPhaseIndex, setDragPhaseIndex] = useState<number | null>(null);

  // Match React Flow's chrome (controls, minimap, background) to the app theme.
  const [colorMode, setColorMode] = useState<ColorMode>("light");
  useEffect(() => {
    setColorMode(document.documentElement.classList.contains("dark") ? "dark" : "light");
  }, []);

  // Seed React Flow state from the stored graph.
  const initialNodes: Node<ActivityNodeData>[] = useMemo(
    () =>
      (template.graph.nodes ?? []).map((n) => {
        const phase = template.graph.phases?.find((p) => p.id === n.phaseId);
        const cat = ACTIVITY_BY_KEY[n.activityKey]?.category ?? "reflecting";
        const locked = lockedSet.has(n.id);
        return {
          id: n.id,
          type: "activity",
          position: n.position,
          deletable: !locked,
          // Completed activities are fully frozen — no delete, no drag/move, and
          // no new arrows in or out (connectable off).
          draggable: !locked,
          connectable: !locked,
          data: {
            activityKey: n.activityKey,
            label: n.label,
            category: cat,
            gating: n.gating ?? ACTIVITY_BY_KEY[n.activityKey]?.defaultGating ?? "REVIEWED",
            instructions: n.instructions ?? "",
            artifact: n.artifact ?? ACTIVITY_BY_KEY[n.activityKey]?.defaultArtifact ?? "",
            phaseId: n.phaseId ?? null,
            phaseName: phase?.name ?? null,
            phaseColor: phase?.color ?? null,
            // Locked = already completed: show the "done" treatment.
            progress: locked ? "completed" : undefined,
          },
        };
      }),
    [template, lockedSet]
  );
  const initialEdges: Edge[] = useMemo(() => {
    const posById = new Map((template.graph.nodes ?? []).map((n) => [n.id, n.position]));
    return toFlowEdges(template.graph.edges ?? [], posById).map((e) =>
      // Any arrow touching a completed activity is locked — its connections can't change.
      lockedSet.has(e.source) || lockedSet.has(e.target) ? { ...e, deletable: false } : e
    );
  }, [template, lockedSet]);

  const [nodes, setNodes] = useNodesState<Node<ActivityNodeData>>(initialNodes);

  // Alignment guides shown while dragging a single node.
  const [helperLineH, setHelperLineH] = useState<number | undefined>(undefined);
  const [helperLineV, setHelperLineV] = useState<number | undefined>(undefined);
  // True while a connection is being drawn (reveals every node's handles).
  const [isConnecting, setIsConnecting] = useState(false);

  const onNodesChange = useCallback(
    (changes: NodeChange<Node<ActivityNodeData>>[]) => {
      setHelperLineH(undefined);
      setHelperLineV(undefined);
      // Snap a single dragged node to other nodes' edges/centers.
      const c = changes[0];
      if (changes.length === 1 && c.type === "position" && c.dragging && c.position) {
        const lines = getHelperLines(c, nodes);
        c.position.x = lines.snapPosition.x ?? c.position.x;
        c.position.y = lines.snapPosition.y ?? c.position.y;
        setHelperLineH(lines.horizontal);
        setHelperLineV(lines.vertical);
      }
      setNodes((nds) => applyNodeChanges(changes, nds));
    },
    [nodes, setNodes]
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  // Loose mode lets you connect any side to any side, either direction. We
  // capture the node the drag STARTED on and force it to be the source, so the
  // arrowhead always lands on the node you drop onto.
  const connectStart = useRef<string | null>(null);
  const onConnectStart = useCallback((_: unknown, params: { nodeId?: string | null }) => {
    connectStart.current = params.nodeId ?? null;
    setIsConnecting(true);
  }, []);
  const onConnectEnd = useCallback(() => setIsConnecting(false), []);

  // An activity has at most one incoming and one outgoing edge. Tag nodes that
  // are fully connected (both) so their handles hide on hover — a node with only
  // one of the two still shows handles so the missing direction can be drawn.
  const outSources = useMemo(() => new Set(edges.map((e) => e.source)), [edges]);
  const inTargets = useMemo(() => new Set(edges.map((e) => e.target)), [edges]);

  // Flow order (entry → next…), so phases/activities are numbered/lettered the
  // same way on the canvas, in the exported image, and in the print outline.
  const flowOrderIndex = useMemo(() => {
    const order = new Map<string, number>();
    const incoming = new Set(edges.map((e) => e.target));
    let id: string | null = (nodes.find((n) => !incoming.has(n.id)) ?? nodes[0])?.id ?? null;
    let i = 0;
    const seen = new Set<string>();
    while (id && !seen.has(id)) {
      seen.add(id);
      order.set(id, i++);
      id = edges.find((e) => e.source === id)?.target ?? null;
    }
    for (const n of nodes) if (!order.has(n.id)) order.set(n.id, i++);
    return order;
  }, [nodes, edges]);

  // Per-phase activity letter (a, b, c… reset each phase), in flow order.
  const nodeLetter = useMemo(() => {
    const m = new Map<string, string>();
    const counts = new Map<string, number>();
    const ordered = [...nodes].sort(
      (a, b) => (flowOrderIndex.get(a.id) ?? 0) - (flowOrderIndex.get(b.id) ?? 0)
    );
    for (const n of ordered) {
      const pid = n.data.phaseId ?? null;
      if (!pid) continue;
      const idx = counts.get(pid) ?? 0;
      counts.set(pid, idx + 1);
      m.set(n.id, orderLetter(idx));
    }
    return m;
  }, [nodes, flowOrderIndex]);

  const flowNodes = useMemo(
    () =>
      nodes.map((n) => {
        const letter = nodeLetter.get(n.id);
        const data = letter === n.data.letter ? n.data : { ...n.data, letter };
        return outSources.has(n.id) && inTargets.has(n.id)
          ? { ...n, data, className: "fully-connected" }
          : { ...n, data };
      }),
    [nodes, outSources, inTargets, nodeLetter]
  );

  // Edges with an explicit stroke + arrow so they survive image export.
  const styledEdges = useMemo(
    () =>
      edges.map((e) => ({
        ...e,
        markerEnd: e.markerEnd ?? ARROW,
        style: { ...EDGE_STYLE, ...(e.style ?? {}) },
      })),
    [edges]
  );
  const onConnect = useCallback(
    (c: Connection) => {
      let { source, target, sourceHandle, targetHandle } = c;
      const start = connectStart.current;
      if (start && target === start && source !== start) {
        [source, target] = [target, source];
        [sourceHandle, targetHandle] = [targetHandle, sourceHandle];
      }
      if (!source || !target || source === target) return;
      // No new arrows in or out of a completed activity.
      if (lockedSet.has(source) || lockedSet.has(target)) return;
      setEdges((eds) => {
        // At most one outgoing per source and one incoming per target.
        if (eds.some((e) => e.source === source)) return eds;
        if (eds.some((e) => e.target === target)) return eds;
        return addEdge(
          { source, target, sourceHandle, targetHandle, id: newId("e"), markerEnd: ARROW },
          eds
        );
      });
    },
    [setEdges, lockedSet]
  );

  // ---- Add activity (drag from palette, or click to drop at center) ----
  const addActivity = useCallback(
    (activityKey: string, position: { x: number; y: number }) => {
      const def = ACTIVITY_BY_KEY[activityKey];
      if (!def) return;
      const node: Node<ActivityNodeData> = {
        id: newId("n"),
        type: "activity",
        position,
        data: {
          activityKey,
          label: def.label,
          category: def.category,
          gating: def.defaultGating,
          instructions: def.defaultInstructions,
          artifact: def.defaultArtifact,
          phaseId: null,
          phaseName: null,
          phaseColor: null,
        },
      };
      setNodes((nds) => nds.concat(node));
    },
    [setNodes]
  );

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const key = e.dataTransfer.getData("application/dewey-activity");
      if (!key) return;
      const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      addActivity(key, position);
    },
    [screenToFlowPosition, addActivity]
  );

  const updateNodeData = useCallback(
    (id: string, patch: Partial<ActivityNodeData>) => {
      setNodes((nds) =>
        nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n))
      );
    },
    [setNodes]
  );

  // Remove the selected activities from whatever phase they're in.
  const removeSelectedFromPhase = useCallback(() => {
    // Completed activities can't be removed from their phase.
    const ids = new Set(
      nodes.filter((n) => n.selected && n.data.phaseId && !lockedSet.has(n.id)).map((n) => n.id)
    );
    if (ids.size === 0) return;
    setNodes((nds) =>
      nds.map((n) =>
        ids.has(n.id)
          ? { ...n, data: { ...n.data, phaseId: null, phaseName: null, phaseColor: null } }
          : n
      )
    );
  }, [nodes, setNodes, lockedSet]);

  // Drag a phase: shift every activity in it by the given flow-space delta (so the
  // whole phase and its contents move together).
  const movePhaseBy = useCallback(
    (phaseId: string, dx: number, dy: number) => {
      setNodes((nds) =>
        nds.map((n) =>
          n.data.phaseId === phaseId
            ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } }
            : n
        )
      );
    },
    [setNodes]
  );

  // ---- Grouping: create a new phase, or add unphased nodes to an existing one ----
  // Disallowed when the selection spans more than one phase.
  const handleGroup = useCallback(() => {
    // Completed activities can't be re-grouped/re-phased.
    const selected = nodes.filter((n) => n.selected && !lockedSet.has(n.id));
    if (selected.length === 0) return;
    const phaseIds = Array.from(
      new Set(selected.map((n) => n.data.phaseId).filter(Boolean) as string[])
    );
    if (phaseIds.length > 1) return; // spans multiple phases — not allowed

    if (phaseIds.length === 1) {
      // Add the unphased selected activities to the one phase represented.
      const phase = phases.find((p) => p.id === phaseIds[0]);
      if (!phase) return;
      const toAdd = new Set(selected.filter((n) => !n.data.phaseId).map((n) => n.id));
      if (toAdd.size === 0) return;
      setNodes((nds) =>
        nds.map((n) =>
          toAdd.has(n.id)
            ? {
                ...n,
                selected: false,
                data: {
                  ...n.data,
                  phaseId: phase.id,
                  phaseName: phase.name,
                  phaseColor: phase.color ?? null,
                },
              }
            : n
        )
      );
      return;
    }

    // No phase in the selection — create a new one from all selected.
    const phaseId = newId("p");
    const color = PHASE_COLORS[phases.length % PHASE_COLORS.length];
    const phase: TemplatePhase = { id: phaseId, name: `Phase ${phases.length + 1}`, color };
    setPhases((ps) => [...ps, phase]);
    const selectedIds = new Set(selected.map((n) => n.id));
    setNodes((nds) =>
      nds.map((n) =>
        selectedIds.has(n.id)
          ? {
              ...n,
              selected: false,
              data: { ...n.data, phaseId, phaseName: phase.name, phaseColor: color },
            }
          : n
      )
    );
  }, [nodes, phases, setNodes, lockedSet]);

  const renamePhase = useCallback(
    (phaseId: string, nextName: string) => {
      setPhases((ps) => ps.map((p) => (p.id === phaseId ? { ...p, name: nextName } : p)));
      setNodes((nds) =>
        nds.map((n) =>
          n.data.phaseId === phaseId ? { ...n, data: { ...n.data, phaseName: nextName } } : n
        )
      );
    },
    [setNodes]
  );

  const removePhase = useCallback(
    (phaseId: string) => {
      setPhases((ps) => ps.filter((p) => p.id !== phaseId));
      setNodes((nds) =>
        nds.map((n) =>
          n.data.phaseId === phaseId
            ? { ...n, data: { ...n.data, phaseId: null, phaseName: null, phaseColor: null } }
            : n
        )
      );
    },
    [setNodes]
  );

  // Edit a phase's name / exit conditions (from the phase modal).
  const updatePhase = useCallback(
    (phaseId: string, patch: { name?: string; exitConditions?: string }) => {
      setPhases((ps) => ps.map((p) => (p.id === phaseId ? { ...p, ...patch } : p)));
      if (patch.name !== undefined) {
        setNodes((nds) =>
          nds.map((n) =>
            n.data.phaseId === phaseId
              ? { ...n, data: { ...n.data, phaseName: patch.name } }
              : n
          )
        );
      }
    },
    [setNodes]
  );

  // Reorder phases (the array order is the sequence). Used by panel drag-and-drop.
  const movePhase = useCallback((from: number, to: number) => {
    if (from === to) return;
    setPhases((ps) => {
      if (from < 0 || from >= ps.length || to < 0 || to >= ps.length) return ps;
      const next = ps.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }, []);

  // Snapshot the canvas into the persisted graph shape (used by Save and the assistant).
  const buildGraph = useCallback(
    (): TemplateGraph => ({
      nodes: nodes.map((n) => ({
        id: n.id,
        activityKey: n.data.activityKey,
        label: n.data.label,
        position: n.position,
        phaseId: n.data.phaseId ?? null,
        gating: n.data.gating,
        instructions: n.data.instructions,
        artifact: n.data.artifact,
      })),
      edges: edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle ?? null,
        targetHandle: e.targetHandle ?? null,
      })),
      phases,
    }),
    [nodes, edges, phases]
  );

  // Load a graph (e.g. an assistant proposal) into the canvas, replacing current state.
  const applyGraph = useCallback(
    (g: TemplateGraph) => {
      setPhases(g.phases ?? []);
      setNodes(
        (g.nodes ?? []).map((n) => {
          const phase = g.phases?.find((p) => p.id === n.phaseId);
          const cat = ACTIVITY_BY_KEY[n.activityKey]?.category ?? "reflecting";
          return {
            id: n.id,
            type: "activity",
            position: n.position,
            data: {
              activityKey: n.activityKey,
              // Labels are fixed by activity type — never custom.
              label: ACTIVITY_BY_KEY[n.activityKey]?.label ?? n.label,
              category: cat,
              gating: n.gating ?? ACTIVITY_BY_KEY[n.activityKey]?.defaultGating ?? "REVIEWED",
              instructions: n.instructions ?? "",
              artifact: n.artifact ?? ACTIVITY_BY_KEY[n.activityKey]?.defaultArtifact ?? "",
              phaseId: n.phaseId ?? null,
              phaseName: phase?.name ?? null,
              phaseColor: phase?.color ?? null,
            },
          };
        })
      );
      setEdges(toFlowEdges(g.edges ?? [], new Map((g.nodes ?? []).map((n) => [n.id, n.position]))));
    },
    [setNodes, setEdges]
  );

  // Merge a graph into the current canvas: fresh ids (no collisions), incoming
  // nodes offset to the right of existing content, phases appended.
  const addGraph = useCallback(
    (g: TemplateGraph) => {
      const phaseIdMap = new Map<string, string>();
      const addedPhases: TemplatePhase[] = (g.phases ?? []).map((p, i) => {
        const id = newId("p");
        phaseIdMap.set(p.id, id);
        return { ...p, id, color: PHASE_COLORS[(phases.length + i) % PHASE_COLORS.length] };
      });

      const curMaxX = nodes.length
        ? Math.max(...nodes.map((n) => n.position.x + (n.measured?.width ?? NODE_W)))
        : 0;
      const incMinX = (g.nodes ?? []).length
        ? Math.min(...(g.nodes ?? []).map((n) => n.position.x))
        : 0;
      const dx = nodes.length ? curMaxX + 80 - incMinX : 0;

      const idMap = new Map<string, string>();
      const addedNodes: Node<ActivityNodeData>[] = (g.nodes ?? []).map((n) => {
        const id = newId("n");
        idMap.set(n.id, id);
        const phaseId = n.phaseId ? phaseIdMap.get(n.phaseId) ?? null : null;
        const phase = addedPhases.find((p) => p.id === phaseId);
        const cat = ACTIVITY_BY_KEY[n.activityKey]?.category ?? "reflecting";
        return {
          id,
          type: "activity",
          position: { x: n.position.x + dx, y: n.position.y },
          data: {
            activityKey: n.activityKey,
            label: ACTIVITY_BY_KEY[n.activityKey]?.label ?? n.label,
            category: cat,
            gating: n.gating ?? ACTIVITY_BY_KEY[n.activityKey]?.defaultGating ?? "REVIEWED",
            instructions: n.instructions ?? "",
            artifact: n.artifact ?? ACTIVITY_BY_KEY[n.activityKey]?.defaultArtifact ?? "",
            phaseId,
            phaseName: phase?.name ?? null,
            phaseColor: phase?.color ?? null,
          },
        };
      });

      const addedPos = new Map(addedNodes.map((n) => [n.id, n.position]));
      const addedEdges: Edge[] = (g.edges ?? [])
        .map((e): Edge | null => {
          const source = idMap.get(e.source);
          const target = idMap.get(e.target);
          if (!source || !target) return null;
          const auto = pickHandles(addedPos.get(source), addedPos.get(target));
          return {
            id: newId("e"),
            source,
            target,
            sourceHandle: e.sourceHandle ?? auto.sourceHandle,
            targetHandle: e.targetHandle ?? auto.targetHandle,
            markerEnd: ARROW,
          };
        })
        .filter((e): e is Edge => e !== null);

      setPhases((ps) => [...ps, ...addedPhases]);
      setNodes((nds) => [...nds, ...addedNodes]);
      setEdges((eds) => [...eds, ...addedEdges]);
    },
    [nodes, phases, setNodes, setEdges]
  );

  // A stable snapshot of the current editor state, for change detection.
  const currentSnapshot = JSON.stringify({ name, graph: buildGraph() });
  // Baseline = state as of the last save (or initial load). Unsaved if it diverges.
  useEffect(() => {
    setSavedSnapshot(currentSnapshot);
    // Only on mount — the baseline is the loaded/empty template.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const dirty = savedSnapshot !== null && currentSnapshot !== savedSnapshot;

  // ---- Save: confirm a description first, create on first save then patch ----
  const draftDescription = useCallback(async () => {
    setDescLoading(true);
    try {
      const { description: draft } = await apiFetch<{ description: string }>(
        "/api/admin/templates/describe",
        { method: "POST", body: { name, graph: buildGraph() } }
      );
      if (draft) setDescDraft(draft);
    } catch {
      /* leave the field as-is if the model is unavailable */
    } finally {
      setDescLoading(false);
    }
  }, [name, buildGraph]);

  const openSaveDialog = useCallback(() => {
    setDescDraft(description);
    setSaveOpen(true);
    // Pre-draft a description with the summarization model when none exists yet.
    if (!description.trim()) draftDescription();
  }, [description, draftDescription]);

  const persist = useCallback(async () => {
    setSaving(true);
    try {
      const graph = buildGraph();
      const desc = descDraft.trim() || null;
      if (savedId == null) {
        const { template: created } = await apiFetch<{ template: CoachingTemplate }>(
          templatesBase,
          { method: "POST", body: { name, description: desc, graph } }
        );
        setSavedId(created.id);
      } else {
        await apiFetch(`${templatesBase}/${savedId}`, {
          method: "PATCH",
          body: { name, description: desc, graph },
        });
      }
      setDescription(desc ?? "");
      setSavedSnapshot(JSON.stringify({ name, graph }));
      setSavedAt(new Date().toLocaleTimeString());
      setSaveOpen(false);
    } catch (e) {
      dialog.alert(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }, [buildGraph, name, savedId, descDraft, templatesBase, dialog]);

  // Warn before discarding unsaved work.
  const handleClose = useCallback(async () => {
    if (
      dirty &&
      !(await dialog.confirm("You have unsaved changes. Close without saving?", {
        title: "Unsaved changes",
        confirmText: "Discard",
        danger: true,
      }))
    )
      return;
    onClose();
  }, [dirty, onClose, dialog]);

  // Render the whole canvas (nodes, colors, edges/arrows, phase clouds) to a PNG,
  // independent of the user's current pan/zoom — fits all nodes into a landscape
  // frame. Returns null if there's nothing to capture.
  const captureCanvasPng = useCallback(async (): Promise<string | null> => {
    const viewport = wrapperRef.current?.querySelector<HTMLElement>(".react-flow__viewport");
    const flowNodes = getNodes();
    if (!viewport || flowNodes.length === 0) return null;
    const bounds = getNodesBounds(flowNodes);
    // Size the capture frame to the plan's own aspect ratio so the image fills
    // the page with minimal whitespace (clamped to keep extreme shapes sane).
    const ratio =
      bounds.width > 0 && bounds.height > 0
        ? Math.min(Math.max(bounds.width / bounds.height, 0.6), 3.2)
        : 1.45;
    const imageHeight = 1200;
    const imageWidth = Math.round(imageHeight * ratio);
    const { x, y, zoom } = getViewportForBounds(bounds, imageWidth, imageHeight, 0.2, 4, "40px");
    return toPng(viewport, {
      backgroundColor: "#ffffff",
      width: imageWidth,
      height: imageHeight,
      pixelRatio: 2,
      style: {
        width: `${imageWidth}px`,
        height: `${imageHeight}px`,
        transform: `translate(${x}px, ${y}px) scale(${zoom})`,
      },
    });
  }, [getNodes]);

  // Print → open a preview window with a self-contained, PDF-ready document: a
  // landscape rendering of the arc (page 1) plus the detailed outline (page 2+).
  // We open the window synchronously (so the pop-up isn't blocked) and fill it in
  // once the image is captured. No print dialog is forced — the user prints from
  // the preview when ready.
  const handlePrint = useCallback(() => {
    const w = window.open("", "_blank", "width=1100,height=800");
    if (!w) {
      dialog.alert("Allow pop-ups for this site to open the plan preview.", {
        title: "Pop-up blocked",
      });
      return;
    }
    w.document.write(
      "<!doctype html><title>Preparing…</title><body style='font-family:system-ui,sans-serif;padding:2rem;color:#555'>Preparing your plan preview…</body>"
    );
    void (async () => {
      let diagram: string | null = null;
      try {
        diagram = await captureCanvasPng();
      } catch {
        diagram = null;
      }
      const html = buildPlanPrintHtml(name || template.name || "Coaching Plan", buildGraph(), {
        diagram,
        description,
      });
      w.document.open();
      w.document.write(html);
      w.document.close();
    })();
  }, [name, template.name, description, buildGraph, dialog, captureCanvasPng]);

  // Reset all progress: cancels every submission server-side, then unlocks all
  // activities in place so the whole plan can be edited. Only when there's progress.
  const handleResetProgress = useCallback(async () => {
    if (lockedSet.size === 0 || savedId == null) return;
    if (
      !(await dialog.confirm(
        "Reset this plan's progress? This permanently cancels every completed and submitted activity for the partner, so you can edit the entire plan. This can't be undone.",
        { title: "Reset progress", confirmText: "Reset progress", danger: true }
      ))
    )
      return;
    try {
      const res = await fetch(pathWithBase(`${templatesBase}/${savedId}/reset-progress`), {
        method: "POST",
      });
      if (!res.ok) throw new Error();
      // Unlock everything in place.
      setNodes((nds) =>
        nds.map((n) => ({
          ...n,
          deletable: true,
          draggable: true,
          connectable: true,
          data: { ...n.data, progress: undefined },
        }))
      );
      setEdges((eds) => eds.map((e) => ({ ...e, deletable: true })));
      setLockedSet(new Set());
    } catch {
      dialog.alert("Couldn't reset the plan's progress.");
    }
  }, [lockedSet, savedId, templatesBase, dialog, setNodes, setEdges]);

  // Clear the whole canvas (activities, edges, and phases).
  const clearCanvas = useCallback(async () => {
    if (
      !(await dialog.confirm("Clear the entire canvas? This removes all activities and phases.", {
        title: "Clear canvas",
        confirmText: "Clear",
        danger: true,
      }))
    )
      return;
    setNodes([]);
    setEdges([]);
    setPhases([]);
  }, [setNodes, setEdges]);

  // ---- Grouping-button state, derived from the current selection ----
  const selectedNodes = nodes.filter((n) => n.selected);
  const selectedPhaseIds = Array.from(
    new Set(selectedNodes.map((n) => n.data.phaseId).filter(Boolean) as string[])
  );
  const unphasedSelectedCount = selectedNodes.filter((n) => !n.data.phaseId).length;
  const multiPhaseSelected = selectedPhaseIds.length > 1;
  const targetPhase =
    selectedPhaseIds.length === 1 ? phases.find((p) => p.id === selectedPhaseIds[0]) : null;
  const groupDisabled =
    selectedNodes.length === 0 ||
    multiPhaseSelected ||
    (selectedPhaseIds.length === 1 && unphasedSelectedCount === 0);
  const groupLabel = targetPhase ? `Add to ${targetPhase.name}` : "Group into new phase";
  const groupTitle = multiPhaseSelected
    ? "Selection spans more than one phase — not allowed"
    : selectedNodes.length === 0
    ? "Select activities first (box-select or shift-click)"
    : undefined;
  const someSelectedInPhase = selectedNodes.some((n) => n.data.phaseId && !lockedSet.has(n.id));

  const editingNode = editingNodeId ? nodes.find((n) => n.id === editingNodeId) : null;
  const editingPhase = editingPhaseId ? phases.find((p) => p.id === editingPhaseId) : null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-dewey-cream">
      {/* Toolbar */}
      <div className="flex items-center gap-3 border-b border-dewey-border px-4 py-2">
        <input
          className="dewey-input max-w-xs"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Plan name"
        />
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-full border border-dewey-accent/40 bg-dewey-accent/5 px-2.5 py-1 text-xs text-dewey-accent hover:bg-dewey-accent/10 disabled:opacity-50"
          onClick={handleGroup}
          disabled={groupDisabled}
          title={groupTitle}
        >
          <span aria-hidden>🧩</span> {groupLabel}
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-full border border-dewey-accent/40 bg-dewey-accent/5 px-2.5 py-1 text-xs text-dewey-accent hover:bg-dewey-accent/10 disabled:opacity-50"
          onClick={removeSelectedFromPhase}
          disabled={!someSelectedInPhase}
          title="Remove the selected activities from their phase"
        >
          <span aria-hidden>✂️</span> Remove from phase
        </button>
        <div className="ml-auto flex items-center gap-3">
          {template.scope === "partnership" && (
            <span className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-700">
              Message thread copy — saves to this conversation only, not your plan library
            </span>
          )}
          {dirty ? (
            <span className="text-xs text-amber-600">Unsaved changes</span>
          ) : savedAt ? (
            <span className="text-xs text-dewey-mute">Saved {savedAt}</span>
          ) : null}
          <button
            type="button"
            className="dewey-btn-secondary w-auto"
            onClick={handlePrint}
            title="Print or save this plan as a PDF"
          >
            <span aria-hidden>🖨️</span> Print
          </button>
          <button
            type="button"
            className="dewey-btn-primary w-auto"
            onClick={openSaveDialog}
            disabled={saving}
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <button type="button" className="dewey-btn-secondary" onClick={handleClose}>
            Close
          </button>
        </div>
      </div>

      {lockedSet.size > 0 && (
        <div className="flex items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-xs text-amber-900">
          <span className="flex-1">
            🔒 Completed activities are locked. You can add new activities and edit the
            not-yet-completed ones; saving sends the revised plan back to everyone to re-accept,
            and the partner resumes at the next unfinished activity.
          </span>
          <button
            type="button"
            className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-300 bg-white px-2.5 py-1 text-amber-800 hover:bg-amber-100"
            onClick={handleResetProgress}
            title="Cancel all progress so the whole plan can be edited"
          >
            <span aria-hidden>↺</span> Reset progress
          </button>
        </div>
      )}

      <div className="flex-1 flex min-h-0">
        {/* Palette */}
        <aside className="w-60 shrink-0 border-r border-dewey-border overflow-y-auto p-3 space-y-4">
          <p className="text-xs text-dewey-mute">
            Drag an activity onto the canvas. Box-select or shift-click to group into a phase.
          </p>
          {(Object.keys(CATEGORY_META) as ActivityCategory[]).map((cat) => (
            <div key={cat}>
              <div className="flex items-center gap-2 mb-1">
                <span
                  className="inline-block w-2 h-2 rounded-full"
                  style={{ background: CATEGORY_META[cat].color }}
                />
                <span className="text-xs font-medium">{CATEGORY_META[cat].label}</span>
              </div>
              <div className="space-y-1">
                {ACTIVITY_TYPES.filter((a) => a.category === cat).map((a) => (
                  <div
                    key={a.key}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData("application/dewey-activity", a.key);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onDoubleClick={() => addActivity(a.key, { x: 80, y: 80 })}
                    className="text-xs px-2 py-1 rounded border border-dewey-border bg-dewey-surface cursor-grab hover:bg-dewey-surface-2"
                    title={[a.defaultInstructions, a.defaultArtifact && `Expected: ${a.defaultArtifact}`]
                      .filter(Boolean)
                      .join("\n\n")}
                  >
                    {a.label}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </aside>

        {/* Canvas — `connecting` reveals all handles while drawing an edge. */}
        <div
          className={`flex-1 min-w-0 dewey-canvas${isConnecting ? " connecting" : ""}`}
          ref={wrapperRef}
          onDrop={onDrop}
          onDragOver={onDragOver}
        >
          <ReactFlow
            nodes={flowNodes}
            edges={styledEdges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onConnectStart={onConnectStart}
            onConnectEnd={onConnectEnd}
            onNodeDoubleClick={(_, node) => {
              if (!lockedSet.has(node.id)) setEditingNodeId(node.id);
            }}
            nodeTypes={nodeTypes}
            colorMode={colorMode}
            defaultEdgeOptions={{ markerEnd: ARROW }}
            connectionMode={ConnectionMode.Loose}
            selectionOnDrag
            panOnDrag={[1, 2]}
            panOnScroll
            selectionMode={SelectionMode.Partial}
            fitView
            fitViewOptions={{ padding: 0.2, maxZoom: 0.85 }}
            proOptions={{ hideAttribution: true }}
          >
            <PhaseClouds phases={phases} onEditPhase={setEditingPhaseId} onMovePhase={movePhaseBy} />
            <Background />
            <HelperLines horizontal={helperLineH} vertical={helperLineV} />
            <Controls fitViewOptions={{ padding: 0.2, maxZoom: 0.85 }}>
              <ControlButton onClick={clearCanvas} title="Clear canvas">
                {/* Inline fill:none overrides React Flow's default
                    `.react-flow__controls-button svg { fill: currentColor }`,
                    which would otherwise fill the ring into a solid disc. */}
                <svg
                  viewBox="0 0 24 24"
                  width="15"
                  height="15"
                  style={{ fill: "none" }}
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="9" />
                  <path d="M15 9l-6 6M9 9l6 6" />
                </svg>
              </ControlButton>
            </Controls>
          </ReactFlow>
        </div>

        {/* Phases panel */}
        <aside className="w-56 shrink-0 border-l border-dewey-border overflow-y-auto p-3">
          <h3 className="text-xs font-semibold mb-1">Phases</h3>
          {phases.length === 0 ? (
            <p className="text-xs text-dewey-mute">
              Select activities and click “Group into new phase”. Double-click an
              activity to edit it.
            </p>
          ) : (
            <>
              <p className="text-[11px] text-dewey-mute mb-2">
                Drag to reorder. Double-click to edit exit conditions.
              </p>
              <ul className="space-y-2">
                {phases.map((p, i) => {
                  const count = nodes.filter((n) => n.data.phaseId === p.id).length;
                  return (
                    <li
                      key={p.id}
                      onDragOver={(e) => {
                        if (dragPhaseIndex !== null) e.preventDefault();
                      }}
                      onDrop={() => {
                        if (dragPhaseIndex !== null) movePhase(dragPhaseIndex, i);
                        setDragPhaseIndex(null);
                      }}
                      onDoubleClick={() => setEditingPhaseId(p.id)}
                      className={`rounded border border-dewey-border p-2 bg-dewey-surface ${
                        dragPhaseIndex === i ? "opacity-50" : ""
                      }`}
                    >
                      <div className="flex items-center gap-1.5 mb-1">
                        <span
                          draggable
                          onDragStart={() => setDragPhaseIndex(i)}
                          onDragEnd={() => setDragPhaseIndex(null)}
                          className="cursor-grab text-dewey-mute select-none px-0.5"
                          title="Drag to reorder"
                        >
                          ⠿
                        </span>
                        <span className="text-[11px] text-dewey-mute w-4 shrink-0">{i + 1}.</span>
                        <span
                          className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                          style={{ background: p.color }}
                        />
                        <input
                          className="dewey-input py-1 text-xs"
                          value={p.name}
                          onChange={(e) => renamePhase(p.id, e.target.value)}
                        />
                      </div>
                      <div className="flex items-center justify-between text-[11px] text-dewey-mute pl-1">
                        <span>
                          {count} activit{count === 1 ? "y" : "ies"}
                          {p.exitConditions ? " · has exit conditions" : ""}
                        </span>
                        <span className="flex items-center gap-2">
                          <button
                            type="button"
                            className="text-dewey-accent hover:underline"
                            onClick={() => setEditingPhaseId(p.id)}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="text-red-700 hover:underline"
                            onClick={() => removePhase(p.id)}
                          >
                            Ungroup
                          </button>
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </aside>
      </div>

      <CanvasAssistant
        buildGraph={buildGraph}
        onApply={applyGraph}
        onAdd={addGraph}
        templateId={savedId}
        canReplace={lockedSet.size === 0}
      />

      {editingNode && (
        <NodeEditModal
          node={editingNode}
          onSave={(patch) => {
            updateNodeData(editingNode.id, patch);
            setEditingNodeId(null);
          }}
          onClose={() => setEditingNodeId(null)}
        />
      )}

      {editingPhase && (
        <PhaseEditModal
          phase={editingPhase}
          onSave={(patch) => {
            updatePhase(editingPhase.id, patch);
            setEditingPhaseId(null);
          }}
          onClose={() => setEditingPhaseId(null)}
        />
      )}

      {saveOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-lg border border-dewey-border bg-dewey-surface p-5 shadow-xl">
            <h2 className="text-base font-semibold text-dewey-ink">Save plan</h2>
            <p className="mt-1 text-sm text-dewey-mute">
              {template.scope === "partnership"
                ? "This saves the message thread's copy in the conversation only — it won't be added to your plan library. Add a short description so everyone knows what it's for."
                : "Add a description so coaches know what this plan is for. We've drafted one you can edit."}
            </p>
            <div className="mt-3">
              <label className="dewey-label">Plan name</label>
              <input
                className="dewey-input mt-1"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Plan name"
              />
            </div>
            <div className="mt-3 flex items-center justify-between">
              <label className="dewey-label mb-0">Description</label>
              <button
                type="button"
                className="text-xs text-dewey-accent hover:underline disabled:opacity-50"
                onClick={draftDescription}
                disabled={descLoading}
              >
                {descLoading ? "Drafting…" : "Regenerate with AI"}
              </button>
            </div>
            <textarea
              className="dewey-input mt-1 h-28 resize-y"
              value={descLoading && !descDraft ? "" : descDraft}
              onChange={(e) => setDescDraft(e.target.value)}
              placeholder={descLoading ? "Drafting a description…" : "Describe this plan…"}
            />
            {template.scope === "partnership" && (
              <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                ⚠️ Saving sends this plan back to everyone in the message thread for re-approval —
                it won't be active again until each participant re-accepts it.
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="dewey-btn-secondary"
                onClick={() => setSaveOpen(false)}
                disabled={saving}
              >
                Cancel
              </button>
              <button
                type="button"
                className="dewey-btn-primary w-auto"
                onClick={persist}
                disabled={saving || !name.trim()}
              >
                {saving ? "Saving…" : "Save plan"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Phase edit modal -------------------------------------------------------

function PhaseEditModal({
  phase,
  onSave,
  onClose,
}: {
  phase: TemplatePhase;
  onSave: (patch: { name: string; exitConditions: string }) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(phase.name);
  const [exitConditions, setExitConditions] = useState(phase.exitConditions ?? "");

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-dewey-surface text-dewey-ink rounded-lg shadow-xl max-w-lg w-full p-6 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold">Edit phase</h3>

        <div>
          <label className="dewey-label">Name</label>
          <input className="dewey-input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>

        <div>
          <label className="dewey-label">Exit conditions</label>
          <textarea
            className="dewey-input min-h-[140px]"
            value={exitConditions}
            onChange={(e) => setExitConditions(e.target.value)}
            placeholder="Criteria the AI evaluates once all activities are done, surfaced to the coach before they approve advancement to the next phase…"
          />
          <p className="text-xs text-dewey-mute mt-1">
            Evaluated across the phase's artifacts — distinct from individual activity done-states.
          </p>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="dewey-btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="dewey-btn-primary w-auto"
            onClick={() => onSave({ name: name.trim() || phase.name, exitConditions })}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- Node edit modal --------------------------------------------------------

function NodeEditModal({
  node,
  onSave,
  onClose,
}: {
  node: Node<ActivityNodeData>;
  onSave: (patch: Partial<ActivityNodeData>) => void;
  onClose: () => void;
}) {
  const def = ACTIVITY_BY_KEY[node.data.activityKey];
  const [gating, setGating] = useState<Gating>(node.data.gating);
  const [instructions, setInstructions] = useState(node.data.instructions);
  const [artifact, setArtifact] = useState(node.data.artifact);

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-dewey-surface text-dewey-ink rounded-lg shadow-xl max-w-lg w-full p-6 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h3 className="text-lg font-semibold">{def?.label ?? node.data.activityKey}</h3>
          <p className="text-xs text-dewey-mute">
            {CATEGORY_META[node.data.category]?.label} · activity type is fixed
          </p>
        </div>

        <div>
          <label className="dewey-label">Completion type</label>
          <select
            className="dewey-input"
            value={gating}
            onChange={(e) => setGating(e.target.value as Gating)}
          >
            <option value="OPEN">{GATING_LABEL.OPEN}</option>
            <option value="REVIEWED">{GATING_LABEL.REVIEWED}</option>
          </select>
          <p className="text-xs text-dewey-mute mt-1">
            Default for this type: {GATING_LABEL[def?.defaultGating ?? "REVIEWED"]}.
          </p>
        </div>

        <div>
          <label className="dewey-label">Instructions</label>
          <textarea
            className="dewey-input min-h-[100px]"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="What the partner should do in this activity…"
          />
        </div>

        <div>
          <label className="dewey-label">Expected artifact / product</label>
          <textarea
            className="dewey-input min-h-[64px]"
            value={artifact}
            onChange={(e) => setArtifact(e.target.value)}
            placeholder="What the partner produces (e.g. reading notes, a goal statement, a recording)…"
          />
          <p className="text-xs text-dewey-mute mt-1">
            The output the coach reviews and the phase-exit check evaluates.
          </p>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="dewey-btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="dewey-btn-primary w-auto"
            onClick={() => onSave({ gating, instructions, artifact })}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- AI assistant -----------------------------------------------------------

type ChatSource = { name: string; path: string };
type ChatTurn = { role: "user" | "assistant"; text: string; sources?: ChatSource[] };

function CanvasAssistant({
  buildGraph,
  onApply,
  onAdd,
  templateId,
  canReplace = true,
}: {
  buildGraph: () => TemplateGraph;
  onApply: (g: TemplateGraph) => void;
  onAdd: (g: TemplateGraph) => void;
  /** The saved plan id (null until first save), used to persist/restore the transcript. */
  templateId: number | null;
  /** When false (plan has progress), the AI can only add — not replace the canvas. */
  canReplace?: boolean;
}) {
  const dialog = useDialog();
  const [open, setOpen] = useState(true);
  const [messages, setMessages] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [proposed, setProposed] = useState<TemplateGraph | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [constructing, setConstructing] = useState(false);
  // Server-assigned conversation id; persisted across turns/sessions.
  const conversationId = useRef<number | null>(null);
  // Resizable transcript height (drag the top border).
  const [transcriptHeight, setTranscriptHeight] = useState(200);
  const transcriptRef = useRef<HTMLDivElement>(null);
  // Auto-scroll only when the user is already near the bottom.
  const stickToBottom = useRef(true);

  // Wake the coaching model when the canvas opens so the first call is warm.
  useEffect(() => {
    fetch(pathWithBase("/api/admin/ai/warmup"), { method: "POST" }).catch(() => {});
  }, []);

  // Restore the saved transcript for this plan when the assistant opens. Only
  // for a saved plan — a brand-new (unsaved) plan starts fresh. Never overwrite
  // an in-progress conversation/messages (guards the null→id post-save re-run).
  useEffect(() => {
    if (templateId == null) return;
    let cancelled = false;
    // Pass any in-progress conversation so that, when this plan was just saved,
    // the server links the existing transcript to the new plan id (so it's
    // restorable next time even if no further message is sent).
    const cidQ = conversationId.current != null ? `&conversationId=${conversationId.current}` : "";
    apiFetch<{ conversationId: number | null; messages: ChatTurn[] }>(
      `/api/admin/templates/assistant?templateId=${templateId}${cidQ}`
    )
      .then((d) => {
        if (cancelled) return;
        if (d.conversationId != null) conversationId.current = d.conversationId;
        if (d.messages.length) setMessages((cur) => (cur.length ? cur : d.messages));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [templateId]);

  // Keep the latest message in view as turns are added and tokens stream in —
  // but only if the user hasn't scrolled up to read earlier messages.
  useEffect(() => {
    const el = transcriptRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Drag the panel's top border to resize the transcript.
  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = transcriptHeight;
      const onMove = (ev: MouseEvent) => {
        const dy = startY - ev.clientY; // dragging up grows the panel
        setTranscriptHeight(Math.max(80, Math.min(window.innerHeight * 0.7, startH + dy)));
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [transcriptHeight]
  );

  const send = useCallback(async () => {
    const q = input.trim();
    if (!q || loading) return;
    setInput("");
    setProposed(null);
    setConstructing(false);
    stickToBottom.current = true; // sending always scrolls the new turn into view
    // Append the user turn and an empty assistant turn we fill as tokens stream in.
    setMessages((m) => [...m, { role: "user", text: q }, { role: "assistant", text: "" }]);
    setLoading(true);

    // Update the trailing assistant turn, preserving any fields (e.g. sources)
    // already attached to it.
    const patchAssistant = (patch: Partial<ChatTurn>) =>
      setMessages((m) => {
        const copy = m.slice();
        copy[copy.length - 1] = { ...copy[copy.length - 1], role: "assistant", ...patch };
        return copy;
      });
    const setAssistant = (text: string) => patchAssistant({ text });
    // Drop the trailing empty assistant placeholder (used for popups/errors).
    const dropEmptyAssistant = () =>
      setMessages((m) =>
        m.length && m[m.length - 1].role === "assistant" && !m[m.length - 1].text
          ? m.slice(0, -1)
          : m
      );

    try {
      const res = await fetch(pathWithBase("/api/admin/templates/assistant"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          graph: buildGraph(),
          message: q,
          conversationId: conversationId.current,
          templateId,
        }),
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let live = "";
      let graph: TemplateGraph | null = null;
      let blocked: string | null = null;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const line = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          let ev: {
            type?: string;
            text?: string;
            reply?: string;
            proposedGraph?: TemplateGraph | null;
            sources?: ChatSource[];
            error?: string;
            reason?: string;
            conversationId?: number;
          };
          try {
            ev = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }
          if (ev.type === "conversation") {
            if (typeof ev.conversationId === "number") conversationId.current = ev.conversationId;
          } else if (ev.type === "text" && ev.text) {
            live += ev.text;
            setAssistant(live);
          } else if (ev.type === "sources") {
            const srcs = ev.sources ?? [];
            patchAssistant({ sources: srcs.length ? srcs : undefined });
          } else if (ev.type === "graph_start") {
            setConstructing(true);
          } else if (ev.type === "blocked") {
            blocked =
              ev.reason?.trim() ||
              "That request couldn’t be processed by the @dewey assistant.";
          } else if (ev.type === "done") {
            patchAssistant({ text: ev.reply || live || "(no response)" });
            graph = ev.proposedGraph ?? null;
          } else if (ev.type === "error") {
            throw new Error(ev.error || "Assistant error");
          }
        }
      }

      if (blocked) {
        // The compliance screen refused the message — drop the empty bubble and
        // show the standard compliance notice in an in-app modal.
        dropEmptyAssistant();
        await dialog.alert(COMPLIANCE_NOTICE, { title: "Compliance notice" });
        return;
      }

      if (graph) {
        setProposed(graph);
        setPreviewing(true); // pop the preview with discard/add/replace options
      }
    } catch (e) {
      // Surface failures as a modal rather than rendering raw error text inline.
      dropEmptyAssistant();
      await dialog.alert(e instanceof Error ? e.message : "Request failed");
    } finally {
      setLoading(false);
      setConstructing(false);
    }
  }, [input, loading, buildGraph, dialog, templateId]);

  return (
    <div className="border-t border-dewey-border bg-dewey-surface">
      {open && (
        <div
          onMouseDown={startResize}
          title="Drag to resize"
          className="h-1.5 w-full cursor-ns-resize hover:bg-dewey-surface-2"
        />
      )}
      <button
        type="button"
        className="w-full flex items-center justify-between px-4 py-1.5 text-xs text-dewey-mute hover:text-dewey-ink"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="font-medium">@dewey assistant</span>
        <span>{open ? "▾ hide" : "▴ show"}</span>
      </button>

      {open && (
        <div className="px-4 pb-3">
          {messages.length > 0 && (
            <div
              ref={transcriptRef}
              onScroll={(e) => {
                const el = e.currentTarget;
                stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
              }}
              style={{ height: transcriptHeight }}
              className="overflow-y-auto space-y-2 mb-2"
            >
              {messages.map((m, i) =>
                m.role === "user" ? (
                  <div key={i} className="text-right">
                    <span className="inline-block rounded-lg px-3 py-1.5 text-sm bg-dewey-primary text-dewey-primary-fg whitespace-pre-wrap">
                      {m.text}
                    </span>
                  </div>
                ) : (
                  <div key={i} className="text-left">
                    <div className="inline-block max-w-[90%] rounded-lg px-3 py-1.5 bg-dewey-surface-2 text-dewey-ink">
                      <div className="chat-md text-sm">
                        {i === messages.length - 1 && loading && !m.text ? (
                          <span className="typing-dots" aria-label="@dewey is typing">
                            <span />
                            <span />
                            <span />
                          </span>
                        ) : (
                          <ReactMarkdown>{m.text || "…"}</ReactMarkdown>
                        )}
                      </div>
                      {i === messages.length - 1 && constructing && (
                        <div className="mt-1 text-xs text-dewey-mute italic animate-pulse">
                          Please wait a moment while I build …
                        </div>
                      )}
                      {m.sources && m.sources.length > 0 && (
                        <div className="mt-1.5 pt-1.5 border-t border-dewey-border flex flex-wrap items-center gap-1.5">
                          <span className="text-[11px] text-dewey-mute">Sources</span>
                          {m.sources.map((s, j) => (
                            <a
                              key={j}
                              href={pathWithBase(
                                `/api/admin/rag/source?path=${encodeURIComponent(s.path)}`
                              )}
                              target="_blank"
                              rel="noreferrer"
                              title={s.name}
                              className="inline-block max-w-[180px] truncate rounded-full border border-dewey-border bg-dewey-surface-2 px-2 py-0.5 text-[11px] text-dewey-mute hover:text-dewey-ink hover:border-dewey-mute"
                            >
                              {s.name}
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )
              )}
            </div>
          )}

          {previewing && proposed && (
            <PreviewModal
              graph={proposed}
              canReplace={canReplace}
              onAdd={() => {
                onAdd(proposed);
                setProposed(null);
                setPreviewing(false);
              }}
              onApply={() => {
                onApply(proposed);
                setProposed(null);
                setPreviewing(false);
              }}
              onDiscard={() => {
                setProposed(null);
                setPreviewing(false);
              }}
            />
          )}

          <div className="flex gap-2">
            <input
              className="dewey-input"
              placeholder="Ask about the graph, request descriptions/exit conditions, or describe an arc to build…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && send()}
              disabled={loading}
            />
            <button
              type="button"
              className="dewey-btn-primary w-auto"
              onClick={send}
              disabled={loading || !input.trim()}
            >
              {loading ? "Thinking…" : "Send"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Proposed-graph preview -------------------------------------------------

function PreviewModal({
  graph,
  canReplace = true,
  onAdd,
  onApply,
  onDiscard,
}: {
  graph: TemplateGraph;
  canReplace?: boolean;
  onAdd: () => void;
  onApply: () => void;
  onDiscard: () => void;
}) {
  const [colorMode, setColorMode] = useState<ColorMode>("light");
  useEffect(() => {
    setColorMode(document.documentElement.classList.contains("dark") ? "dark" : "light");
  }, []);

  const nodes: Node<ActivityNodeData>[] = useMemo(
    () =>
      (graph.nodes ?? []).map((n) => {
        const phase = graph.phases?.find((p) => p.id === n.phaseId);
        const cat = ACTIVITY_BY_KEY[n.activityKey]?.category ?? "reflecting";
        return {
          id: n.id,
          type: "activity",
          position: n.position,
          data: {
            activityKey: n.activityKey,
            label: ACTIVITY_BY_KEY[n.activityKey]?.label ?? n.label,
            category: cat,
            gating: n.gating ?? "REVIEWED",
            instructions: n.instructions ?? "",
            artifact: n.artifact ?? ACTIVITY_BY_KEY[n.activityKey]?.defaultArtifact ?? "",
            phaseId: n.phaseId ?? null,
            phaseName: phase?.name ?? null,
            phaseColor: phase?.color ?? null,
          },
        };
      }),
    [graph]
  );
  const edges: Edge[] = useMemo(() => {
    const posById = new Map((graph.nodes ?? []).map((n) => [n.id, n.position]));
    return toFlowEdges(graph.edges ?? [], posById);
  }, [graph]);

  return (
    <div
      className="fixed inset-0 z-[70] bg-black/50 flex items-center justify-center p-6"
      onClick={onDiscard}
    >
      <div
        className="bg-dewey-surface rounded-lg shadow-xl w-full max-w-4xl h-[70vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-2 border-b border-dewey-border">
          <h3 className="text-sm font-semibold">Proposed arc — preview</h3>
          <span className="text-xs text-dewey-mute">
            {nodes.length} activities · {graph.phases?.length ?? 0} phases
          </span>
        </div>
        <div className="flex-1 min-h-0">
          {/* Own provider so the preview's React Flow store is isolated from the editor's. */}
          <ReactFlowProvider>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              colorMode={colorMode}
              connectionMode={ConnectionMode.Loose}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={false}
              fitView
              fitViewOptions={{ padding: 0.2, maxZoom: 0.85 }}
              proOptions={{ hideAttribution: true }}
            >
              <PhaseClouds phases={graph.phases ?? []} />
              <Background />
            </ReactFlow>
          </ReactFlowProvider>
        </div>
        <div className="flex justify-end gap-2 px-4 py-2 border-t border-dewey-border">
          <button type="button" className="dewey-btn-secondary" onClick={onDiscard}>
            Discard
          </button>
          {canReplace ? (
            <button
              type="button"
              className="dewey-btn-secondary"
              onClick={onApply}
              title="Replace everything on the canvas"
            >
              Replace canvas
            </button>
          ) : (
            <span className="self-center text-xs text-dewey-mute">
              Replace is disabled — this plan has progress. Reset progress to replace it.
            </span>
          )}
          <button
            type="button"
            className="dewey-btn-primary w-auto"
            onClick={onAdd}
            title="Append to the current canvas"
          >
            Add to canvas
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- Loader wrapper ---------------------------------------------------------

export function TemplateCanvas({
  templateId,
  onClose,
  templatesBase = "/api/admin/templates",
}: {
  templateId: number | null; // null = a new, not-yet-saved template
  onClose: () => void;
  /** CRUD base. Defaults to the admin namespace; coaches pass "/api/coach/templates". */
  templatesBase?: string;
}) {
  const [template, setTemplate] = useState<CoachingTemplate | null>(
    templateId === null
      ? {
          id: 0, // 0 = unsaved; created on first Save
          name: "Untitled plan",
          description: null,
          graph: EMPTY_GRAPH,
          scope: "personal",
          owner_id: null,
          created_by: null,
          created_at: "",
          updated_at: "",
          deleted_at: null,
        }
      : null
  );
  const [error, setError] = useState<string | null>(null);
  // Completed (approved) activity ids that must stay locked while editing an
  // active partnership plan (the GET returns these for /api/partnership-plans).
  const [lockedNodeIds, setLockedNodeIds] = useState<string[]>([]);

  useEffect(() => {
    if (templateId === null) return; // new template — nothing to load
    let cancelled = false;
    apiFetch<{ template: CoachingTemplate; completedNodeIds?: string[] }>(
      `${templatesBase}/${templateId}`
    )
      .then((d) => {
        if (cancelled) return;
        setTemplate(d.template);
        setLockedNodeIds(d.completedNodeIds ?? []);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load plan");
      });
    return () => {
      cancelled = true;
    };
  }, [templateId, templatesBase]);

  if (error) {
    return (
      <div className="fixed inset-0 z-50 bg-dewey-cream flex flex-col items-center justify-center gap-3">
        <p className="text-red-600">{error}</p>
        <button type="button" className="dewey-btn-secondary" onClick={onClose}>
          Close
        </button>
      </div>
    );
  }
  if (!template) {
    return (
      <div className="fixed inset-0 z-50 bg-dewey-cream flex items-center justify-center">
        <p className="text-dewey-mute">Loading plan…</p>
      </div>
    );
  }

  return (
    <ReactFlowProvider>
      <CanvasInner
        template={template}
        onClose={onClose}
        templatesBase={templatesBase}
        lockedNodeIds={lockedNodeIds}
      />
    </ReactFlowProvider>
  );
}

// ---- Read-only viewer -------------------------------------------------------

/**
 * A full-screen, locked view of a template's canvas. Coaches see global
 * templates this way: the graph is rendered exactly as on the editor but nothing
 * is draggable/editable. Actions let them duplicate it into an editable personal
 * copy (or, later, apply it to a partnership).
 */
export function TemplateReadOnly({
  templateId,
  templatesBase = "/api/admin/templates",
  onClose,
  onDuplicate,
  duplicating = false,
  focusCurrentActivity = false,
}: {
  templateId: number;
  templatesBase?: string;
  onClose: () => void;
  /** Make an editable personal copy. Omit to hide the Duplicate action (e.g. when an admin opens a template from a log). */
  onDuplicate?: () => void;
  duplicating?: boolean;
  /** Open straight to the current activity's detail (the "View current activity" entry point). */
  focusCurrentActivity?: boolean;
}) {
  const [template, setTemplate] = useState<CoachingTemplate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [colorMode, setColorMode] = useState<ColorMode>("light");
  // Clicking an activity or a phase opens this read-only detail panel.
  const [detail, setDetail] = useState<
    | { kind: "activity"; data: ActivityNodeData }
    | { kind: "phase"; phase: TemplatePhase }
    | null
  >(null);

  useEffect(() => {
    setColorMode(document.documentElement.classList.contains("dark") ? "dark" : "light");
  }, []);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ template: CoachingTemplate }>(`${templatesBase}/${templateId}`)
      .then((d) => {
        if (!cancelled) setTemplate(d.template);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load plan");
      });
    return () => {
      cancelled = true;
    };
  }, [templateId, templatesBase]);

  const graph = template?.graph ?? EMPTY_GRAPH;
  // For an accepted partnership plan, derive each activity's progress from the
  // current node: the current activity is green, every activity that can reach
  // it (its predecessors) is "completed" (grayed), the rest are upcoming.
  const progressByNode = useMemo(() => {
    const map = new Map<string, "completed" | "current" | "upcoming">();
    const current = template?.current_node_id;
    // Only an active (accepted, not finished/abandoned) plan shows progress; a
    // terminal or superseded plan is viewable but has no current-activity shading.
    if (!current || !template?.accepted_at || template?.outcome) return map;
    // Predecessor adjacency: target -> [sources].
    const preds = new Map<string, string[]>();
    for (const e of graph.edges ?? []) {
      const list = preds.get(e.target) ?? [];
      list.push(e.source);
      preds.set(e.target, list);
    }
    const completed = new Set<string>();
    const stack = [...(preds.get(current) ?? [])];
    while (stack.length) {
      const id = stack.pop() as string;
      if (completed.has(id) || id === current) continue;
      completed.add(id);
      for (const p of preds.get(id) ?? []) stack.push(p);
    }
    for (const n of graph.nodes ?? []) {
      map.set(n.id, n.id === current ? "current" : completed.has(n.id) ? "completed" : "upcoming");
    }
    return map;
  }, [graph, template?.current_node_id, template?.accepted_at]);

  const nodes: Node<ActivityNodeData>[] = useMemo(
    () =>
      (graph.nodes ?? []).map((n) => {
        const phase = graph.phases?.find((p) => p.id === n.phaseId);
        const cat = ACTIVITY_BY_KEY[n.activityKey]?.category ?? "reflecting";
        return {
          id: n.id,
          type: "activity",
          position: n.position,
          data: {
            activityKey: n.activityKey,
            label: ACTIVITY_BY_KEY[n.activityKey]?.label ?? n.label,
            category: cat,
            gating: n.gating ?? "REVIEWED",
            instructions: n.instructions ?? "",
            artifact: n.artifact ?? ACTIVITY_BY_KEY[n.activityKey]?.defaultArtifact ?? "",
            phaseId: n.phaseId ?? null,
            phaseName: phase?.name ?? null,
            phaseColor: phase?.color ?? null,
            progress: progressByNode.get(n.id),
            clickable: true,
          },
        };
      }),
    [graph, progressByNode]
  );
  const edges: Edge[] = useMemo(() => {
    const posById = new Map((graph.nodes ?? []).map((n) => [n.id, n.position]));
    return toFlowEdges(graph.edges ?? [], posById);
  }, [graph]);

  // "View current activity" entry point: once the plan loads, open straight to
  // the current node's detail panel (over the canvas behind it).
  useEffect(() => {
    if (!focusCurrentActivity || !template?.current_node_id) return;
    const node = nodes.find((n) => n.id === template.current_node_id);
    if (node) setDetail({ kind: "activity", data: node.data });
    // Only on first load of this plan — re-running on every node change would
    // fight the user closing the panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusCurrentActivity, template?.current_node_id, template?.id]);

  if (error) {
    return (
      <div className="fixed inset-0 z-50 bg-dewey-cream flex flex-col items-center justify-center gap-3">
        <p className="text-red-600">{error}</p>
        <button type="button" className="dewey-btn-secondary" onClick={onClose}>
          Close
        </button>
      </div>
    );
  }
  if (!template) {
    return (
      <div className="fixed inset-0 z-50 bg-dewey-cream flex items-center justify-center">
        <p className="text-dewey-mute">Loading plan…</p>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-dewey-cream">
      <div className="flex items-center gap-3 border-b border-dewey-border px-4 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-sm font-semibold text-dewey-ink">{template.name}</h2>
            {template.scope === "global" && (
              <span className="rounded bg-dewey-surface-2 px-2 py-0.5 text-xs text-dewey-mute">
                Global plan
              </span>
            )}
          </div>
          {template.description && (
            <p className="text-xs text-dewey-mute">{template.description}</p>
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {onDuplicate && (
            <button
              type="button"
              className="dewey-btn-primary w-auto"
              onClick={onDuplicate}
              disabled={duplicating}
            >
              {duplicating ? "Duplicating…" : "Duplicate to edit"}
            </button>
          )}
          <button type="button" className="dewey-btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0">
        <ReactFlowProvider>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            colorMode={colorMode}
            connectionMode={ConnectionMode.Loose}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            onNodeClick={(_e, node) => setDetail({ kind: "activity", data: node.data as ActivityNodeData })}
            fitView
            fitViewOptions={{ padding: 0.28, maxZoom: 0.85 }}
            proOptions={{ hideAttribution: true }}
          >
            <PhaseClouds
              phases={graph.phases ?? []}
              onPhaseInfo={(id) => {
                const phase = (graph.phases ?? []).find((p) => p.id === id);
                if (phase) setDetail({ kind: "phase", phase });
              }}
            />
            <Background />
            <Controls showInteractive={false} fitViewOptions={{ padding: 0.28, maxZoom: 0.85 }} />
          </ReactFlow>
        </ReactFlowProvider>
      </div>
      {detail && <PlanDetailModal detail={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

/** Read-only detail panel for an activity or phase clicked in a plan preview. */
function PlanDetailModal({
  detail,
  onClose,
}: {
  detail:
    | { kind: "activity"; data: ActivityNodeData }
    | { kind: "phase"; phase: TemplatePhase };
  onClose: () => void;
}) {
  const isActivity = detail.kind === "activity";
  const d = isActivity ? detail.data : null;
  const p = !isActivity ? detail.phase : null;
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-lg bg-dewey-surface p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-dewey-mute">
              {isActivity ? "Activity" : "Phase"}
            </div>
            <h3 className="text-base font-semibold text-dewey-ink">
              {isActivity ? d!.label : p!.name}
            </h3>
          </div>
          <button
            type="button"
            className="shrink-0 text-sm text-dewey-mute hover:text-dewey-ink"
            onClick={onClose}
          >
            Close
          </button>
        </div>
        {isActivity ? (
          <dl className="space-y-3 text-sm">
            <DetailRow label="Category">{CATEGORY_META[d!.category]?.label ?? d!.category}</DetailRow>
            <DetailRow label="Completion">{GATING_LABEL[d!.gating]}</DetailRow>
            {d!.phaseName && <DetailRow label="Phase">{d!.phaseName}</DetailRow>}
            <DetailBlock label="Instructions">
              {d!.instructions || ACTIVITY_BY_KEY[d!.activityKey]?.defaultInstructions || "—"}
            </DetailBlock>
            <DetailBlock label="Expected artifact">
              {d!.artifact || ACTIVITY_BY_KEY[d!.activityKey]?.defaultArtifact || "—"}
            </DetailBlock>
          </dl>
        ) : (
          <dl className="space-y-3 text-sm">
            <DetailBlock label="Exit conditions">
              {p!.exitConditions || "Not set."}
            </DetailBlock>
          </dl>
        )}
      </div>
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-dewey-mute">{label}</dt>
      <dd className="text-right font-medium text-dewey-ink">{children}</dd>
    </div>
  );
}

function DetailBlock({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-dewey-mute">{label}</dt>
      <dd className="mt-0.5 whitespace-pre-wrap text-dewey-ink">{children}</dd>
    </div>
  );
}
