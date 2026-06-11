"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  MarkerType,
  SelectionMode,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Node,
  type Edge,
  type Connection,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { apiFetch } from "@/lib/api-client";
import {
  ACTIVITY_TYPES,
  ACTIVITY_BY_KEY,
  CATEGORY_META,
  type ActivityCategory,
} from "@/lib/activities";
import type { CoachingTemplate, TemplateGraph, TemplatePhase } from "@/lib/templates";

// Colors cycled through as phases are created.
const PHASE_COLORS = ["#2563eb", "#16a34a", "#9333ea", "#ea580c", "#0891b2", "#db2777"];

type ActivityNodeData = {
  activityKey: string;
  label: string;
  category: ActivityCategory;
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
        markerEnd: { type: MarkerType.ArrowClosed },
      })),
    [template]
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<ActivityNodeData>>(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  const onConnect = useCallback(
    (c: Connection) =>
      setEdges((eds) =>
        addEdge({ ...c, id: newId("e"), markerEnd: { type: MarkerType.ArrowClosed } }, eds)
      ),
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

  // ---- Grouping selected nodes into a phase ----
  const groupIntoPhase = useCallback(() => {
    const selected = nodes.filter((n) => n.selected);
    if (selected.length === 0) {
      alert("Select activities first (drag a box around them or shift-click).");
      return;
    }
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

  // ---- Save ----
  const save = useCallback(async () => {
    setSaving(true);
    try {
      const graph: TemplateGraph = {
        nodes: nodes.map((n) => ({
          id: n.id,
          activityKey: n.data.activityKey,
          label: n.data.label,
          position: n.position,
          phaseId: n.data.phaseId ?? null,
        })),
        edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
        phases,
      };
      await apiFetch(`/api/admin/templates/${template.id}`, {
        method: "PATCH",
        body: { name, graph },
      });
      setSavedAt(new Date().toLocaleTimeString());
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }, [nodes, edges, phases, name, template.id]);

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
        <button type="button" className="dewey-btn-secondary" onClick={groupIntoPhase}>
          Group selection into phase
        </button>
        <div className="ml-auto flex items-center gap-3">
          {savedAt && <span className="text-xs text-dewey-mute">Saved {savedAt}</span>}
          <button type="button" className="dewey-btn-primary w-auto" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
          <button type="button" className="dewey-btn-secondary" onClick={onClose}>
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
            nodeTypes={nodeTypes}
            defaultEdgeOptions={{ markerEnd: { type: MarkerType.ArrowClosed } }}
            selectionOnDrag
            panOnDrag={[1, 2]}
            panOnScroll
            selectionMode={SelectionMode.Partial}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background />
            <Controls />
            <MiniMap pannable zoomable />
          </ReactFlow>
        </div>

        {/* Phases panel */}
        <aside className="w-56 shrink-0 border-l border-dewey-border overflow-y-auto p-3">
          <h3 className="text-xs font-semibold mb-2">Phases</h3>
          {phases.length === 0 ? (
            <p className="text-xs text-dewey-mute">
              Select activities and click “Group selection into phase”.
            </p>
          ) : (
            <ul className="space-y-2">
              {phases.map((p) => {
                const count = nodes.filter((n) => n.data.phaseId === p.id).length;
                return (
                  <li key={p.id} className="rounded border border-dewey-border p-2">
                    <div className="flex items-center gap-2 mb-1">
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
                    <div className="flex items-center justify-between text-[11px] text-dewey-mute">
                      <span>{count} activit{count === 1 ? "y" : "ies"}</span>
                      <button
                        type="button"
                        className="text-red-700 hover:underline"
                        onClick={() => removePhase(p.id)}
                      >
                        Ungroup
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>
      </div>
    </div>
  );
}

// ---- Loader wrapper ---------------------------------------------------------

export function TemplateCanvas({
  templateId,
  onClose,
}: {
  templateId: number;
  onClose: () => void;
}) {
  const [template, setTemplate] = useState<CoachingTemplate | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
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
