"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { apiFetch } from "@/lib/api-client";
import { useDialog } from "@/components/DialogProvider";
import type { CoachingTemplate } from "@/lib/templates";

const ADMIN_BASE = "/api/admin/templates";

/** Accent pill action used on plan cards — matches the coach canvas pills. */
function CardPill({
  icon,
  label,
  onClick,
  disabled,
  title,
}: {
  icon: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="inline-flex items-center gap-1 rounded-full border border-dewey-accent/40 bg-dewey-accent/5 px-2 py-0.5 text-xs text-dewey-accent hover:bg-dewey-accent/10 disabled:opacity-50"
    >
      <span aria-hidden>{icon}</span> {label}
    </button>
  );
}

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

/**
 * Admin Coaching Canvas. The admin builds plans as drafts, then publishes them to
 * the global library (no approval needed). Global plans are editable here too.
 * Coach submissions still flow through the approval panel.
 */
export function AdminTemplates() {
  const dialog = useDialog();
  const [templates, setTemplates] = useState<CoachingTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const { templates } = await apiFetch<{ templates: CoachingTemplate[] }>(ADMIN_BASE);
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

  const remove = useCallback(
    async (t: CoachingTemplate) => {
      if (
        !(await dialog.confirm(
          `Delete "${t.name}"? It will be hidden but recoverable from the audit log.`,
          { title: "Delete plan", confirmText: "Delete", danger: true }
        ))
      )
        return;
      setBusy(true);
      try {
        await apiFetch(`${ADMIN_BASE}/${t.id}`, { method: "DELETE" });
        await load();
      } catch (e) {
        dialog.alert(e instanceof Error ? e.message : "Failed to delete plan");
      } finally {
        setBusy(false);
      }
    },
    [load, dialog]
  );

  const publish = useCallback(
    async (t: CoachingTemplate) => {
      if (
        !(await dialog.confirm(
          `Publish "${t.name}" to the global library? It becomes available to every coach district-wide.`,
          { title: "Publish plan", confirmText: "Publish" }
        ))
      )
        return;
      setBusy(true);
      try {
        await apiFetch(`${ADMIN_BASE}/${t.id}/publish`, { method: "POST" });
        await load();
      } catch (e) {
        dialog.alert(e instanceof Error ? e.message : "Failed to publish plan");
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

  const drafts = templates.filter((t) => t.scope === "personal");
  const global = templates.filter((t) => t.scope === "global");

  return (
    <section>
      <div className="mb-4">
        <h2 className="text-lg font-semibold">Coaching Canvas</h2>
        <p className="text-sm text-dewey-mute">
          Build plans as drafts, then publish them to the global library for all coaches.
        </p>
        <div className="mt-3 flex justify-center">
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-full border border-dewey-accent/40 bg-dewey-accent/5 px-3 py-1 text-xs text-dewey-accent hover:bg-dewey-accent/10 disabled:opacity-50"
            onClick={() => setEditing("new")}
            disabled={busy}
          >
            <span aria-hidden>🗂️</span> New plan
          </button>
        </div>
      </div>

      <SubmissionsPanel onDecided={load} />

      {loading ? (
        <p className="text-dewey-mute">Loading plans…</p>
      ) : error ? (
        <p className="text-red-600">{error}</p>
      ) : (
        <div className="space-y-6">
          <Group
            title="Draft Plans"
            empty="No drafts yet. Start a new plan, then publish it when it's ready."
            items={drafts}
            onOpen={(t) => setEditing(t.id)}
            renderActions={(t) => (
              <>
                <CardPill icon="✏️" label="Edit" onClick={() => setEditing(t.id)} />
                <CardPill
                  icon="🌐"
                  label="Publish to global"
                  onClick={() => publish(t)}
                  disabled={busy}
                />
                <CardPill icon="🗑️" label="Delete" onClick={() => remove(t)} disabled={busy} />
              </>
            )}
          />

          <Group
            title="Global plans"
            empty="No global plans yet."
            items={global}
            onOpen={(t) => setEditing(t.id)}
            renderActions={(t) => (
              <>
                <CardPill icon="✏️" label="Edit" onClick={() => setEditing(t.id)} />
                <CardPill icon="🗑️" label="Delete" onClick={() => remove(t)} disabled={busy} />
              </>
            )}
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
  renderActions,
  onOpen,
}: {
  title: string;
  empty: string;
  items: CoachingTemplate[];
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
              className="rounded-lg border border-dewey-border bg-dewey-surface p-3"
            >
              <button
                type="button"
                className="block w-full cursor-pointer text-left"
                onClick={() => onOpen(t)}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{t.name}</span>
                  {t.scope === "global" && t.owner_name && (
                    <span className="text-[11px] text-dewey-mute">
                      Submitted by {t.owner_name}
                    </span>
                  )}
                </div>
                {t.description && (
                  <div className="whitespace-pre-wrap text-xs text-dewey-mute">{t.description}</div>
                )}
                <div className="text-xs text-dewey-mute">
                  {t.graph.nodes.length} activit{t.graph.nodes.length === 1 ? "y" : "ies"} ·{" "}
                  {t.graph.phases.length} phase{t.graph.phases.length === 1 ? "" : "s"}
                </div>
              </button>
              <div className="mt-2 flex flex-wrap items-center justify-center gap-1.5">
                {renderActions(t)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
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
      const message = await dialog.prompt(`Optional reply to ${s.coach_name ?? "the coach"}:`, {
        title: `${verb} "${s.template_name ?? "plan"}"`,
        multiline: true,
        confirmText: verb,
        placeholder: "Add a note (optional)…",
      });
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
                from {s.coach_name ?? "a coach"} · {new Date(s.created_at).toLocaleDateString()}
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
