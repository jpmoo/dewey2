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
  useReactFlow,
  type Node,
  type Edge,
  type Connection,
  type NodeProps,
  type NodeChange,
  type ColorMode,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { apiFetch } from "@/lib/api-client";
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

type ActivityNodeData = {
  activityKey: string;
  label: string;
  category: ActivityCategory;
  gating: Gating;
  instructions: string;
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
  return (
    <div
      className="rounded-md border bg-dewey-surface text-dewey-ink shadow-sm text-xs"
      style={{
        borderColor: data.phaseColor || catColor,
        borderWidth: selected ? 2 : 1,
        minWidth: 150,
      }}
    >
      <Handle type="target" position={Position.Top} />
      <div className="h-1 rounded-t" style={{ background: catColor }} />
      <div className="px-2 py-1.5">
        <div className="font-medium leading-tight">{data.label}</div>
        <div className="text-[10px] text-dewey-mute mt-0.5">{data.gating}</div>
        {data.phaseName && (
          <div
            className="mt-1 inline-block rounded px-1.5 py-0.5 text-[10px] text-white"
            style={{ background: data.phaseColor || catColor }}
          >
            {data.phaseName}
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

const nodeTypes = { activity: ActivityNode };

// ---- Editor -----------------------------------------------------------------

function CanvasInner({
  template,
  onClose,
}: {
  template: CoachingTemplate;
  onClose: () => void;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition } = useReactFlow();

  const [name, setName] = useState(template.name);
  const [phases, setPhases] = useState<TemplatePhase[]>(template.graph.phases ?? []);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
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
        markerEnd: ARROW,
      })),
    [template]
  );

  const [nodes, setNodes] = useNodesState<Node<ActivityNodeData>>(initialNodes);

  // Alignment guides shown while dragging a single node.
  const [helperLineH, setHelperLineH] = useState<number | undefined>(undefined);
  const [helperLineV, setHelperLineV] = useState<number | undefined>(undefined);

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

  // React Flow assigns source/target by handle type, not drag direction. We
  // capture the node the drag STARTED on and force it to be the source, so flow
  // always follows the direction you draw and the arrowhead lands on the target.
  const connectStart = useRef<string | null>(null);
  const onConnectStart = useCallback(
    (_: unknown, params: { nodeId?: string | null }) => {
      connectStart.current = params.nodeId ?? null;
    },
    []
  );
  const onConnect = useCallback(
    (c: Connection) => {
      let { source, target, sourceHandle, targetHandle } = c;
      const start = connectStart.current;
      if (start && target === start && source !== start) {
        // RF made the start node the target — swap so it's the source.
        [source, target] = [target, source];
        [sourceHandle, targetHandle] = [targetHandle, sourceHandle];
      }
      if (!source || !target || source === target) return;
      setEdges((eds) =>
        addEdge({ source, target, sourceHandle, targetHandle, id: newId("e"), markerEnd: ARROW }, eds)
      );
    },
    [setEdges]
  );

  // A translucent "cloud" behind each phase, sized to its members' bounding box
  // (plus padding and a strip for the label). Recomputed as nodes move/measure.
  const LABEL_STRIP = 30;
  const PAD = 26;
  const phaseClouds = useMemo(() => {
    return phases
      .map((p) => {
        const members = nodes.filter((n) => n.data.phaseId === p.id);
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
          x: minX - PAD,
          y: minY - PAD - LABEL_STRIP,
          w: maxX - minX + PAD * 2,
          h: maxY - minY + PAD * 2 + LABEL_STRIP,
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);
  }, [phases, nodes]);

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
          instructions: "",
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
      })),
      edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
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
              phaseId: n.phaseId ?? null,
              phaseName: phase?.name ?? null,
              phaseColor: phase?.color ?? null,
            },
          };
        })
      );
      setEdges((g.edges ?? []).map((e) => ({ id: e.id, source: e.source, target: e.target, markerEnd: ARROW })));
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
          return { id: newId("e"), source, target, markerEnd: ARROW };
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

  // ---- Save: create on first save (new template), then patch ----
  const save = useCallback(async () => {
    setSaving(true);
    try {
      const graph = buildGraph();
      if (savedId == null) {
        const { template: created } = await apiFetch<{ template: CoachingTemplate }>(
          "/api/admin/templates",
          { method: "POST", body: { name, graph } }
        );
        setSavedId(created.id);
      } else {
        await apiFetch(`/api/admin/templates/${savedId}`, {
          method: "PATCH",
          body: { name, graph },
        });
      }
      setSavedSnapshot(JSON.stringify({ name, graph }));
      setSavedAt(new Date().toLocaleTimeString());
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }, [buildGraph, name, savedId]);

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
          placeholder="Template name"
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
          <button type="button" className="dewey-btn-primary w-auto" onClick={save} disabled={saving}>
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
                    title="Drag onto the canvas (or double-click to add)"
                  >
                    {a.label}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </aside>

        {/* Canvas */}
        <div className="flex-1 min-w-0" ref={wrapperRef} onDrop={onDrop} onDragOver={onDragOver}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onConnectStart={onConnectStart}
            onNodeDoubleClick={(_, node) => setEditingNodeId(node.id)}
            nodeTypes={nodeTypes}
            colorMode={colorMode}
            defaultEdgeOptions={{ markerEnd: ARROW }}
            // Loose mode: the node you drag FROM is the source, the node you
            // drop ON is the target — so flow follows draw direction and the
            // arrowhead always lands on the target (the next activity).
            connectionMode={ConnectionMode.Loose}
            selectionOnDrag
            panOnDrag={[1, 2]}
            panOnScroll
            selectionMode={SelectionMode.Partial}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <ViewportPortal>
              {phaseClouds.map((c) => (
                <div
                  key={c.id}
                  // Positioned in flow coordinates; the portal applies the
                  // viewport transform. Behind nodes and non-interactive.
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
                    onDoubleClick={() => setEditingPhaseId(c.id)}
                    title="Double-click to edit phase exit conditions"
                    style={{
                      position: "absolute",
                      top: 10,
                      left: 20,
                      fontSize: 11,
                      fontWeight: 600,
                      color: c.color,
                      cursor: "pointer",
                      pointerEvents: "auto", // label is clickable; the cloud body isn't
                    }}
                  >
                    {c.name}
                  </span>
                </div>
              ))}
            </ViewportPortal>
            <Background />
            <HelperLines horizontal={helperLineH} vertical={helperLineV} />
            <Controls>
              <ControlButton onClick={clearCanvas} title="Clear canvas">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="dewey-btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="dewey-btn-primary w-auto"
            onClick={() => onSave({ gating, instructions })}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- AI assistant -----------------------------------------------------------

type ChatTurn = { role: "user" | "assistant"; text: string };

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

  const send = useCallback(async () => {
    const q = input.trim();
    if (!q || loading) return;
    setInput("");
    setProposed(null);
    const history = messages;
    setMessages((m) => [...m, { role: "user", text: q }]);
    setLoading(true);
    try {
      const res = await apiFetch<{ reply: string; proposedGraph: TemplateGraph | null }>(
        "/api/admin/templates/assistant",
        { method: "POST", body: { graph: buildGraph(), message: q, history } }
      );
      setMessages((m) => [...m, { role: "assistant", text: res.reply || "(no response)" }]);
      if (res.proposedGraph) setProposed(res.proposedGraph);
    } catch (e) {
      setMessages((m) => [
        ...m,
        { role: "assistant", text: e instanceof Error ? e.message : "Request failed" },
      ]);
    } finally {
      setLoading(false);
    }
  }, [input, loading, messages, buildGraph]);

  return (
    <div className="border-t border-dewey-border bg-dewey-surface">
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
            <div className="max-h-44 overflow-y-auto space-y-2 mb-2">
              {messages.map((m, i) => (
                <div key={i} className={m.role === "user" ? "text-right" : "text-left"}>
                  <span
                    className={`inline-block rounded-lg px-3 py-1.5 text-sm whitespace-pre-wrap ${
                      m.role === "user"
                        ? "bg-dewey-ink text-white"
                        : "bg-dewey-surface-2 text-dewey-ink"
                    }`}
                  >
                    {m.text}
                  </span>
                </div>
              ))}
            </div>
          )}

          {proposed && (
            <div className="flex items-center justify-between gap-2 mb-2 rounded-md border border-dewey-accent/40 bg-dewey-accent/10 px-3 py-2 text-sm">
              <span>
                The assistant proposed {proposed.nodes.length} activities and{" "}
                {proposed.phases.length} phases.
              </span>
              <span className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  className="dewey-btn-secondary"
                  onClick={() => setPreviewing(true)}
                >
                  Preview
                </button>
                <button
                  type="button"
                  className="dewey-btn-primary w-auto"
                  onClick={() => {
                    onAdd(proposed);
                    setProposed(null);
                  }}
                  title="Append to the current canvas"
                >
                  Add to canvas
                </button>
                <button
                  type="button"
                  className="dewey-btn-secondary"
                  onClick={() => {
                    onApply(proposed);
                    setProposed(null);
                  }}
                  title="Replace everything on the canvas"
                >
                  Replace canvas
                </button>
                <button
                  type="button"
                  className="dewey-btn-secondary"
                  onClick={() => setProposed(null)}
                >
                  Discard
                </button>
              </span>
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
              onClose={() => setPreviewing(false)}
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
  onClose,
}: {
  graph: TemplateGraph;
  onAdd: () => void;
  onApply: () => void;
  onClose: () => void;
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
            phaseId: n.phaseId ?? null,
            phaseName: phase?.name ?? null,
            phaseColor: phase?.color ?? null,
          },
        };
      }),
    [graph]
  );
  const edges: Edge[] = useMemo(
    () => (graph.edges ?? []).map((e) => ({ id: e.id, source: e.source, target: e.target, markerEnd: ARROW })),
    [graph]
  );

  // Phase clouds from the saved positions. Preview nodes are static (no live
  // measurement), so use a fixed height that accounts for the phase chip.
  const clouds = useMemo(() => {
    const LABEL_STRIP = 30;
    const PAD = 26;
    const MEMBER_H = 84;
    return (graph.phases ?? [])
      .map((p) => {
        const members = (graph.nodes ?? []).filter((n) => n.phaseId === p.id);
        if (members.length === 0) return null;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const n of members) {
          minX = Math.min(minX, n.position.x);
          minY = Math.min(minY, n.position.y);
          maxX = Math.max(maxX, n.position.x + NODE_W);
          maxY = Math.max(maxY, n.position.y + MEMBER_H);
        }
        const color = p.color ?? "#2563eb";
        return {
          id: p.id,
          name: p.name,
          color,
          x: minX - PAD,
          y: minY - PAD - LABEL_STRIP,
          w: maxX - minX + PAD * 2,
          h: maxY - minY + PAD * 2 + LABEL_STRIP,
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);
  }, [graph]);

  return (
    <div
      className="fixed inset-0 z-[70] bg-black/50 flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="bg-dewey-surface rounded-lg shadow-xl w-full max-w-4xl h-[70vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-2 border-b border-dewey-border">
          <h3 className="text-sm font-semibold">Proposed graph — preview</h3>
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
                      style={{
                        position: "absolute",
                        top: 10,
                        left: 20,
                        fontSize: 11,
                        fontWeight: 600,
                        color: c.color,
                      }}
                    >
                      {c.name}
                    </span>
                  </div>
                ))}
              </ViewportPortal>
              <Background />
            </ReactFlow>
          </ReactFlowProvider>
        </div>
        <div className="flex justify-end gap-2 px-4 py-2 border-t border-dewey-border">
          <button type="button" className="dewey-btn-secondary" onClick={onClose}>
            Close
          </button>
          <button type="button" className="dewey-btn-secondary" onClick={onApply}>
            Replace canvas
          </button>
          <button type="button" className="dewey-btn-primary w-auto" onClick={onAdd}>
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
}: {
  templateId: number | null; // null = a new, not-yet-saved template
  onClose: () => void;
}) {
  const [template, setTemplate] = useState<CoachingTemplate | null>(
    templateId === null
      ? {
          id: 0, // 0 = unsaved; created on first Save
          name: "Untitled template",
          description: null,
          graph: EMPTY_GRAPH,
          created_by: null,
          created_at: "",
          updated_at: "",
        }
      : null
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (templateId === null) return; // new template — nothing to load
    let cancelled = false;
    apiFetch<{ template: CoachingTemplate }>(`/api/admin/templates/${templateId}`)
      .then((d) => {
        if (!cancelled) setTemplate(d.template);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load template");
      });
    return () => {
      cancelled = true;
    };
  }, [templateId]);

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
        <p className="text-dewey-mute">Loading template…</p>
      </div>
    );
  }

  return (
    <ReactFlowProvider>
      <CanvasInner template={template} onClose={onClose} />
    </ReactFlowProvider>
  );
}
