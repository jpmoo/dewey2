"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { apiFetch } from "@/lib/api-client";
import { useDialog } from "@/components/DialogProvider";
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
  const dialog = useDialog();
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
      setError(e instanceof Error ? e.message : "Failed to load plans");
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
        !(await dialog.confirm(
          `Delete "${t.name}"? It will be hidden from coaches but recoverable from the audit log.`,
          { title: "Delete plan", confirmText: "Delete", danger: true }
        ))
      )
        return;
      setBusy(true);
      try {
        await apiFetch(`/api/admin/templates/${t.id}`, { method: "DELETE" });
        await load();
      } catch (e) {
        dialog.alert(e instanceof Error ? e.message : "Failed to delete plan");
      } finally {
        setBusy(false);
      }
    },
    [load, dialog]
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
          <h2 className="text-lg font-semibold">Coaching plans</h2>
          <p className="text-sm text-dewey-mute">
            Reusable arcs of activities and phases, available to all coaches.
          </p>
        </div>
        <button type="button" className="dewey-btn-secondary" onClick={createNew} disabled={busy}>
          + New plan
        </button>
      </div>

      <SubmissionsPanel onDecided={load} />

      {loading ? (
        <p className="text-dewey-mute">Loading plans…</p>
      ) : error ? (
        <p className="text-red-600">{error}</p>
      ) : templates.length === 0 ? (
        <p className="text-sm text-dewey-mute py-4">
          No plans yet. Create one to start building on the canvas.
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

type Submission = {
  thread_id: number;
  template_id: number | null;
  template_name: string | null;
  coach_name: string | null;
  message: string | null;
  created_at: string;
};

/** Pending plan submissions from coaches, with approve/reject + a reply. */
function SubmissionsPanel({ onDecided }: { onDecided: () => void }) {
  const dialog = useDialog();
  const [subs, setSubs] = useState<Submission[]>([]);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const { submissions } = await apiFetch<{ submissions: Submission[] }>(
        "/api/admin/templates/submissions"
      );
      setSubs(submissions);
    } catch {
      setSubs([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const decide = useCallback(
    async (s: Submission, decision: "approve" | "reject") => {
      const verb = decision === "approve" ? "Approve" : "Reject";
      const message = await dialog.prompt(
        `Optional reply to ${s.coach_name ?? "the coach"}:`,
        {
          title: `${verb} "${s.template_name ?? "plan"}"`,
          multiline: true,
          confirmText: verb,
          placeholder: "Add a note (optional)…",
        }
      );
      // Cancel on the prompt aborts the decision.
      if (message === null) return;
      setBusyId(s.thread_id);
      try {
        await apiFetch(`/api/admin/templates/submissions/${s.thread_id}/decision`, {
          method: "POST",
          body: { decision, message },
        });
        await load();
        onDecided();
      } catch (e) {
        dialog.alert(e instanceof Error ? e.message : "Failed to record decision");
      } finally {
        setBusyId(null);
      }
    },
    [load, onDecided, dialog]
  );

  if (subs.length === 0) return null;

  return (
    <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 p-3">
      <h3 className="mb-2 text-sm font-semibold text-amber-900">
        Pending submissions ({subs.length})
      </h3>
      <ul className="space-y-2">
        {subs.map((s) => (
          <li
            key={s.thread_id}
            className="flex items-start justify-between gap-3 rounded-md border border-amber-200 bg-dewey-surface p-2"
          >
            <div className="min-w-0">
              <div className="text-sm font-medium text-dewey-ink">
                {s.template_name ?? "Untitled template"}
              </div>
              <div className="text-xs text-dewey-mute">
                from {s.coach_name ?? "a coach"} ·{" "}
                {new Date(s.created_at).toLocaleDateString()}
              </div>
              {s.message && (
                <div className="mt-1 text-xs text-dewey-ink line-clamp-2">{s.message}</div>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                className="text-xs text-green-700 hover:underline disabled:opacity-50"
                onClick={() => decide(s, "approve")}
                disabled={busyId === s.thread_id}
              >
                Approve
              </button>
              <button
                type="button"
                className="text-xs text-red-700 hover:underline disabled:opacity-50"
                onClick={() => decide(s, "reject")}
                disabled={busyId === s.thread_id}
              >
                Reject
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
