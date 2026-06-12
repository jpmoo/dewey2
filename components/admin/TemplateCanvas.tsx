"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { getHelperLines, HelperLines } from "./helper-lines";
import {
  ACTIVITY_TYPES,
  ACTIVITY_BY_KEY,
  CATEGORY_META,
  type ActivityCategory,
  type Gating,
} from "@/lib/activities";
import { EMPTY_GRAPH } from "@/lib/templates";
import type { CoachingTemplate, TemplateGraph, TemplatePhase } from "@/lib/templates";

// Colors cycled through as phases are created.
const PHASE_COLORS = ["#2563eb", "#16a34a", "#9333ea", "#ea580c", "#0891b2", "#db2777"];

// The arrowhead sits on the target end (the activity an edge flows into).
const ARROW = { type: MarkerType.ArrowClosed, width: 22, height: 22 } as const;

// Fallback node dimensions before React Flow has measured them.
const NODE_W = 170;
const NODE_H = 64;

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
}: {
  phases: TemplatePhase[];
  onEditPhase?: (id: string) => void;
}) {
  const nodes = useNodes();
  const clouds = useMemo(() => {
    return phases
      .map((p) => {
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
          name: p.name,
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
      {clouds.map((c) => (
        <div
          key={c.id}
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
            pointerEvents: "none",
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
              cursor: onEditPhase ? "pointer" : "default",
              pointerEvents: onEditPhase ? "auto" : "none",
            }}
          >
            {c.name}
          </span>
        </div>
      ))}
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
};

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
  return (
    <div
      className="rounded-md border bg-dewey-surface text-dewey-ink shadow-sm text-xs"
      title={tip || undefined}
      style={{
        borderColor: data.phaseColor || catColor,
        borderWidth: selected ? 2 : 1,
        minWidth: 150,
      }}
    >
      {/* A handle on every side; all are source-typed but connect both ways in
          loose mode, so you can draw a connection from/to any side, any way. */}
      <Handle type="source" position={Position.Top} id="top" />
      <Handle type="source" position={Position.Left} id="left" />
      <Handle type="source" position={Position.Right} id="right" />
      <div className="h-1 rounded-t" style={{ background: catColor }} />
      <div className="px-2 py-1.5">
        <div className="font-medium leading-tight">{data.label}</div>
        <div className="text-[10px] text-dewey-mute mt-0.5">{data.gating}</div>
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
}: {
  template: CoachingTemplate;
  onClose: () => void;
  /** CRUD base path: "/api/admin/templates" (admin) or "/api/coach/templates" (coach). */
  templatesBase: string;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition } = useReactFlow();

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
        return {
          id: n.id,
          type: "activity",
          position: n.position,
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
          },
        };
      }),
    [template]
  );
  const initialEdges: Edge[] = useMemo(
    () =>
      (template.graph.edges ?? []).map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle ?? undefined,
        targetHandle: e.targetHandle ?? undefined,
        markerEnd: ARROW,
      })),
    [template]
  );

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
  const flowNodes = useMemo(
    () =>
      nodes.map((n) =>
        outSources.has(n.id) && inTargets.has(n.id)
          ? { ...n, className: "fully-connected" }
          : n
      ),
    [nodes, outSources, inTargets]
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
    [setEdges]
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
    const ids = new Set(
      nodes.filter((n) => n.selected && n.data.phaseId).map((n) => n.id)
    );
    if (ids.size === 0) return;
    setNodes((nds) =>
      nds.map((n) =>
        ids.has(n.id)
          ? { ...n, data: { ...n.data, phaseId: null, phaseName: null, phaseColor: null } }
          : n
      )
    );
  }, [nodes, setNodes]);

  // ---- Grouping: create a new phase, or add unphased nodes to an existing one ----
  // Disallowed when the selection spans more than one phase.
  const handleGroup = useCallback(() => {
    const selected = nodes.filter((n) => n.selected);
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
  }, [nodes, phases, setNodes]);

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
      setEdges(
        (g.edges ?? []).map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          sourceHandle: e.sourceHandle ?? undefined,
          targetHandle: e.targetHandle ?? undefined,
          markerEnd: ARROW,
        }))
      );
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

      const addedEdges: Edge[] = (g.edges ?? [])
        .map((e): Edge | null => {
          const source = idMap.get(e.source);
          const target = idMap.get(e.target);
          if (!source || !target) return null;
          return {
            id: newId("e"),
            source,
            target,
            sourceHandle: e.sourceHandle ?? undefined,
            targetHandle: e.targetHandle ?? undefined,
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
      alert(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }, [buildGraph, name, savedId, descDraft, templatesBase]);

  // Warn before discarding unsaved work.
  const handleClose = useCallback(() => {
    if (dirty && !confirm("You have unsaved changes. Close without saving?")) return;
    onClose();
  }, [dirty, onClose]);

  // Clear the whole canvas (activities, edges, and phases).
  const clearCanvas = useCallback(() => {
    if (!confirm("Clear the entire canvas? This removes all activities and phases.")) return;
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
  const someSelectedInPhase = selectedNodes.some((n) => n.data.phaseId);

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
          className="dewey-btn-secondary"
          onClick={handleGroup}
          disabled={groupDisabled}
          title={groupTitle}
        >
          {groupLabel}
        </button>
        <button
          type="button"
          className="dewey-btn-secondary"
          onClick={removeSelectedFromPhase}
          disabled={!someSelectedInPhase}
          title="Remove the selected activities from their phase"
        >
          Remove from phase
        </button>
        <div className="ml-auto flex items-center gap-3">
          {dirty ? (
            <span className="text-xs text-amber-600">Unsaved changes</span>
          ) : savedAt ? (
            <span className="text-xs text-dewey-mute">Saved {savedAt}</span>
          ) : null}
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
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onConnectStart={onConnectStart}
            onConnectEnd={onConnectEnd}
            onNodeDoubleClick={(_, node) => setEditingNodeId(node.id)}
            nodeTypes={nodeTypes}
            colorMode={colorMode}
            defaultEdgeOptions={{ markerEnd: ARROW }}
            connectionMode={ConnectionMode.Loose}
            selectionOnDrag
            panOnDrag={[1, 2]}
            panOnScroll
            selectionMode={SelectionMode.Partial}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <PhaseClouds phases={phases} onEditPhase={setEditingPhaseId} />
            <Background />
            <HelperLines horizontal={helperLineH} vertical={helperLineV} />
            <Controls>
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

      <CanvasAssistant buildGraph={buildGraph} onApply={applyGraph} onAdd={addGraph} />

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
              Add a description so coaches know what this plan is for. We&apos;ve drafted one
              you can edit.
            </p>
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
                disabled={saving}
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
          <label className="dewey-label">Completion gating</label>
          <select
            className="dewey-input"
            value={gating}
            onChange={(e) => setGating(e.target.value as Gating)}
          >
            <option value="OPEN">OPEN — partner self-attests</option>
            <option value="REVIEWED">REVIEWED — coach approves</option>
          </select>
          <p className="text-xs text-dewey-mute mt-1">
            Default for this type: {def?.defaultGating ?? "REVIEWED"}.
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
}: {
  buildGraph: () => TemplateGraph;
  onApply: (g: TemplateGraph) => void;
  onAdd: (g: TemplateGraph) => void;
}) {
  const [open, setOpen] = useState(true);
  const [messages, setMessages] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [proposed, setProposed] = useState<TemplateGraph | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [constructing, setConstructing] = useState(false);
  // Resizable transcript height (drag the top border).
  const [transcriptHeight, setTranscriptHeight] = useState(200);
  const transcriptRef = useRef<HTMLDivElement>(null);
  // Auto-scroll only when the user is already near the bottom.
  const stickToBottom = useRef(true);

  // Wake the coaching model when the canvas opens so the first call is warm.
  useEffect(() => {
    fetch(pathWithBase("/api/admin/ai/warmup"), { method: "POST" }).catch(() => {});
  }, []);

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
    const history = messages;
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
        body: JSON.stringify({ graph: buildGraph(), message: q, history }),
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
          };
          try {
            ev = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }
          if (ev.type === "text" && ev.text) {
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
              "That request can't be processed by the coaching assistant.";
          } else if (ev.type === "done") {
            patchAssistant({ text: ev.reply || live || "(no response)" });
            graph = ev.proposedGraph ?? null;
          } else if (ev.type === "error") {
            throw new Error(ev.error || "Assistant error");
          }
        }
      }

      if (blocked) {
        // The compliance screen refused the message — drop the empty bubble and warn.
        dropEmptyAssistant();
        window.alert(blocked);
        return;
      }

      if (graph) {
        setProposed(graph);
        setPreviewing(true); // pop the preview with discard/add/replace options
      }
    } catch (e) {
      // Surface failures as a popup rather than rendering raw error text inline.
      dropEmptyAssistant();
      window.alert(e instanceof Error ? e.message : "Request failed");
    } finally {
      setLoading(false);
      setConstructing(false);
    }
  }, [input, loading, messages, buildGraph]);

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
        <span className="font-medium">AI assistant</span>
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
                          <span className="typing-dots" aria-label="Assistant is typing">
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
  onAdd,
  onApply,
  onDiscard,
}: {
  graph: TemplateGraph;
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
  const edges: Edge[] = useMemo(
    () =>
      (graph.edges ?? []).map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle ?? undefined,
        targetHandle: e.targetHandle ?? undefined,
        markerEnd: ARROW,
      })),
    [graph]
  );

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
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={false}
              fitView
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
          <button
            type="button"
            className="dewey-btn-secondary"
            onClick={onApply}
            title="Replace everything on the canvas"
          >
            Replace canvas
          </button>
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

  useEffect(() => {
    if (templateId === null) return; // new template — nothing to load
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
      <CanvasInner template={template} onClose={onClose} templatesBase={templatesBase} />
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
}: {
  templateId: number;
  templatesBase?: string;
  onClose: () => void;
  /** Make an editable personal copy. Omit to hide the Duplicate action (e.g. when an admin opens a template from a log). */
  onDuplicate?: () => void;
  duplicating?: boolean;
}) {
  const [template, setTemplate] = useState<CoachingTemplate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [colorMode, setColorMode] = useState<ColorMode>("light");

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
  const edges: Edge[] = useMemo(
    () =>
      (graph.edges ?? []).map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle ?? undefined,
        targetHandle: e.targetHandle ?? undefined,
        markerEnd: ARROW,
      })),
    [graph]
  );

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
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-sm font-semibold text-dewey-ink">{template.name}</h2>
            <span className="rounded bg-dewey-surface-2 px-2 py-0.5 text-xs text-dewey-mute">
              {template.scope === "global" ? "Global plan" : "Read-only"}
            </span>
          </div>
          {template.description && (
            <p className="truncate text-xs text-dewey-mute">{template.description}</p>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden sm:inline text-xs text-dewey-mute">
            {onDuplicate ? "Locked — duplicate to make changes" : "Read-only"}
          </span>
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
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <PhaseClouds phases={graph.phases ?? []} />
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
        </ReactFlowProvider>
      </div>
    </div>
  );
}
