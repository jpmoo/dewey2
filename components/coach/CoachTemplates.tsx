"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { apiFetch } from "@/lib/api-client";
import type { CoachingTemplate } from "@/lib/templates";

const COACH_BASE = "/api/coach/templates";

// React Flow is browser-only, so load the canvas components client-side.
const TemplateCanvas = dynamic(
  () => import("@/components/admin/TemplateCanvas").then((m) => m.TemplateCanvas),
  { ssr: false, loading: () => <CanvasLoading /> }
);
const TemplateReadOnly = dynamic(
  () => import("@/components/admin/TemplateCanvas").then((m) => m.TemplateReadOnly),
  { ssr: false, loading: () => <CanvasLoading /> }
);

function CanvasLoading() {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-dewey-cream">
      <p className="text-dewey-mute">Loading canvas…</p>
    </div>
  );
}

/**
 * Coaching Canvas tab. Coaches see global (admin) templates read-only and their
 * own personal templates as editable. They can start blank, duplicate any
 * template into an editable copy, and edit/delete their own.
 */
export function CoachTemplates() {
  const [templates, setTemplates] = useState<CoachingTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Editable canvas: number = own template; "new" = blank draft; null = closed.
  const [editing, setEditing] = useState<number | "new" | null>(null);
  // Read-only viewer for a global template.
  const [viewing, setViewing] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const { templates } = await apiFetch<{ templates: CoachingTemplate[] }>(COACH_BASE);
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

  const duplicate = useCallback(
    async (id: number) => {
      setBusy(true);
      try {
        const { template } = await apiFetch<{ template: CoachingTemplate }>(
          `${COACH_BASE}/${id}/duplicate`,
          { method: "POST" }
        );
        await load();
        // Drop the read-only viewer (if open) and edit the new copy.
        setViewing(null);
        setEditing(template.id);
      } catch (e) {
        alert(e instanceof Error ? e.message : "Failed to duplicate template");
      } finally {
        setBusy(false);
      }
    },
    [load]
  );

  const remove = useCallback(
    async (t: CoachingTemplate) => {
      if (!confirm(`Delete "${t.name}"? This is your personal template.`)) return;
      setBusy(true);
      try {
        await apiFetch(`${COACH_BASE}/${t.id}`, { method: "DELETE" });
        await load();
      } catch (e) {
        alert(e instanceof Error ? e.message : "Failed to delete template");
      } finally {
        setBusy(false);
      }
    },
    [load]
  );

  // Full-screen canvas / viewer take over the page.
  if (editing !== null) {
    return (
      <TemplateCanvas
        templateId={editing === "new" ? null : editing}
        templatesBase={COACH_BASE}
        onClose={async () => {
          setEditing(null);
          await load();
        }}
      />
    );
  }
  if (viewing !== null) {
    return (
      <TemplateReadOnly
        templateId={viewing}
        templatesBase={COACH_BASE}
        duplicating={busy}
        onDuplicate={() => duplicate(viewing)}
        onClose={() => setViewing(null)}
      />
    );
  }

  const mine = templates.filter((t) => t.scope === "personal");
  const global = templates.filter((t) => t.scope === "global");

  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Coaching Canvas</h2>
          <p className="text-sm text-dewey-mute">
            Build coaching plans on the canvas. Global templates are read-only — duplicate one to
            make it your own.
          </p>
        </div>
        <button
          type="button"
          className="dewey-btn-secondary"
          onClick={() => setEditing("new")}
          disabled={busy}
        >
          + New template
        </button>
      </div>

      {loading ? (
        <p className="text-dewey-mute">Loading templates…</p>
      ) : error ? (
        <p className="text-red-600">{error}</p>
      ) : (
        <div className="space-y-6">
          <Group
            title="My templates"
            empty="You haven't created any templates yet. Start a new one, or duplicate a global template below."
            items={mine}
            renderActions={(t) => (
              <>
                <button
                  type="button"
                  className="text-xs text-dewey-accent hover:underline"
                  onClick={() => setEditing(t.id)}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="text-xs text-dewey-accent hover:underline disabled:opacity-50"
                  onClick={() => duplicate(t.id)}
                  disabled={busy}
                >
                  Duplicate
                </button>
                <button
                  type="button"
                  className="text-xs text-red-700 hover:underline disabled:opacity-50"
                  onClick={() => remove(t)}
                  disabled={busy}
                >
                  Delete
                </button>
              </>
            )}
            onOpen={(t) => setEditing(t.id)}
          />

          <Group
            title="Global templates"
            empty="No global templates have been published yet."
            items={global}
            badge="Read-only"
            renderActions={(t) => (
              <>
                <button
                  type="button"
                  className="text-xs text-dewey-accent hover:underline"
                  onClick={() => setViewing(t.id)}
                >
                  View
                </button>
                <button
                  type="button"
                  className="text-xs text-dewey-accent hover:underline disabled:opacity-50"
                  onClick={() => duplicate(t.id)}
                  disabled={busy}
                >
                  Duplicate
                </button>
              </>
            )}
            onOpen={(t) => setViewing(t.id)}
          />
        </div>
      )}
    </section>
  );
}

function Group({
  title,
  empty,
  items,
  badge,
  renderActions,
  onOpen,
}: {
  title: string;
  empty: string;
  items: CoachingTemplate[];
  badge?: string;
  renderActions: (t: CoachingTemplate) => React.ReactNode;
  onOpen: (t: CoachingTemplate) => void;
}) {
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold text-dewey-ink">{title}</h3>
      {items.length === 0 ? (
        <p className="py-2 text-sm text-dewey-mute">{empty}</p>
      ) : (
        <ul className="space-y-2">
          {items.map((t) => (
            <li
              key={t.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-dewey-border bg-dewey-surface p-3"
            >
              <button
                type="button"
                className="min-w-0 flex-1 cursor-pointer text-left"
                onClick={() => onOpen(t)}
              >
                <div className="flex items-center gap-2">
                  <span className="font-medium">{t.name}</span>
                  {badge && (
                    <span className="rounded bg-dewey-surface-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-dewey-mute">
                      {badge}
                    </span>
                  )}
                </div>
                {t.description && (
                  <div className="truncate text-xs text-dewey-mute">{t.description}</div>
                )}
                <div className="text-xs text-dewey-mute">
                  {t.graph.nodes.length} activit{t.graph.nodes.length === 1 ? "y" : "ies"} ·{" "}
                  {t.graph.phases.length} phase{t.graph.phases.length === 1 ? "" : "s"}
                </div>
              </button>
              <div className="flex shrink-0 items-center gap-3">{renderActions(t)}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
