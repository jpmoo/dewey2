"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { apiFetch } from "@/lib/api-client";
import type { CoachingTemplate } from "@/lib/templates";

// The canvas pulls in React Flow (browser-only), so load it client-side only.
const TemplateCanvas = dynamic(
  () => import("./TemplateCanvas").then((m) => m.TemplateCanvas),
  { ssr: false, loading: () => <CanvasLoading /> }
);

function CanvasLoading() {
  return (
    <div className="fixed inset-0 z-50 bg-dewey-cream flex items-center justify-center">
      <p className="text-dewey-mute">Loading canvas…</p>
    </div>
  );
}

export function AdminTemplates() {
  const [templates, setTemplates] = useState<CoachingTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // number = edit existing; "new" = unsaved draft; null = list view.
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const { templates } = await apiFetch<{ templates: CoachingTemplate[] }>(
        "/api/admin/templates"
      );
      setTemplates(templates);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load templates");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Open a blank canvas; nothing is persisted until the user hits Save.
  const createNew = useCallback(() => setEditing("new"), []);

  const remove = useCallback(
    async (t: CoachingTemplate) => {
      if (
        !confirm(
          `Delete "${t.name}"? It will be hidden from coaches but recoverable from the audit log.`
        )
      )
        return;
      setBusy(true);
      try {
        await apiFetch(`/api/admin/templates/${t.id}`, { method: "DELETE" });
        await load();
      } catch (e) {
        alert(e instanceof Error ? e.message : "Failed to delete template");
      } finally {
        setBusy(false);
      }
    },
    [load]
  );

  if (editing !== null) {
    return (
      <TemplateCanvas
        templateId={editing === "new" ? null : editing}
        onClose={async () => {
          setEditing(null);
          await load();
        }}
      />
    );
  }

  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Coaching templates</h2>
          <p className="text-sm text-dewey-mute">
            Reusable arcs of activities and phases, available to all coaches.
          </p>
        </div>
        <button type="button" className="dewey-btn-secondary" onClick={createNew} disabled={busy}>
          + New template
        </button>
      </div>

      {loading ? (
        <p className="text-dewey-mute">Loading templates…</p>
      ) : error ? (
        <p className="text-red-600">{error}</p>
      ) : templates.length === 0 ? (
        <p className="text-sm text-dewey-mute py-4">
          No templates yet. Create one to start building on the canvas.
        </p>
      ) : (
        <ul className="space-y-2">
          {templates.map((t) => (
            <li
              key={t.id}
              className="flex items-center justify-between gap-3 p-3 rounded-lg border border-dewey-border bg-dewey-surface"
            >
              <button
                type="button"
                className="min-w-0 text-left flex-1 cursor-pointer"
                onClick={() => setEditing(t.id)}
              >
                <div className="font-medium">{t.name}</div>
                {t.description && (
                  <div className="text-xs text-dewey-mute truncate">{t.description}</div>
                )}
                <div className="text-xs text-dewey-mute">
                  {t.graph.nodes.length} activit{t.graph.nodes.length === 1 ? "y" : "ies"} ·{" "}
                  {t.graph.phases.length} phase{t.graph.phases.length === 1 ? "" : "s"}
                </div>
              </button>
              <div className="flex items-center gap-3 shrink-0">
                <button
                  type="button"
                  className="text-xs text-dewey-accent hover:underline"
                  onClick={() => setEditing(t.id)}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="text-xs text-red-700 hover:underline disabled:opacity-50"
                  onClick={() => remove(t)}
                  disabled={busy}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
