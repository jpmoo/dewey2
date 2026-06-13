"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { apiFetch } from "@/lib/api-client";
import { useDialog } from "@/components/DialogProvider";
import type { CoachingTemplate } from "@/lib/templates";

const COACH_BASE = "/api/coach/templates";

/** Accent pill action used on plan cards — matches the message-center plan pills. */
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
  const dialog = useDialog();
  const [templates, setTemplates] = useState<CoachingTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Editable canvas: number = own template; "new" = blank draft; null = closed.
  const [editing, setEditing] = useState<number | "new" | null>(null);
  // Read-only viewer for a global template.
  const [viewing, setViewing] = useState<number | null>(null);
  // Share / submit dialogs (the template they target).
  const [sharing, setSharing] = useState<CoachingTemplate | null>(null);
  const [submitting, setSubmitting] = useState<CoachingTemplate | null>(null);

  const load = useCallback(async () => {
    try {
      const { templates } = await apiFetch<{ templates: CoachingTemplate[] }>(COACH_BASE);
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
        dialog.alert(e instanceof Error ? e.message : "Failed to duplicate plan");
      } finally {
        setBusy(false);
      }
    },
    [load, dialog]
  );

  const remove = useCallback(
    async (t: CoachingTemplate) => {
      if (
        !(await dialog.confirm(
          `Delete "${t.name}"? It will be hidden, and an admin can recover it if needed.`,
          { title: "Delete plan", confirmText: "Delete", danger: true }
        ))
      )
        return;
      setBusy(true);
      try {
        await apiFetch(`${COACH_BASE}/${t.id}`, { method: "DELETE" });
        await load();
      } catch (e) {
        dialog.alert(e instanceof Error ? e.message : "Failed to delete plan");
      } finally {
        setBusy(false);
      }
    },
    [load, dialog]
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
      <div className="mb-4">
        <h2 className="text-lg font-semibold">Coaching Canvas</h2>
        <p className="text-sm text-dewey-mute">
          Build coaching plans on the canvas. Global plans are read-only — duplicate one to make it
          your own.
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

      {loading ? (
        <p className="text-dewey-mute">Loading plans…</p>
      ) : error ? (
        <p className="text-red-600">{error}</p>
      ) : (
        <div className="space-y-6">
          <Group
            title="My plans"
            empty="You haven&apos;t created any plans yet. Start a new one, or duplicate a global plan below."
            items={mine}
            renderActions={(t) => (
              <>
                <CardPill icon="✏️" label="Edit" onClick={() => setEditing(t.id)} />
                <CardPill icon="🔗" label="Share" onClick={() => setSharing(t)} />
                <CardPill
                  icon="📤"
                  label="Submit"
                  onClick={() => setSubmitting(t)}
                  title="Submit for district-wide consideration"
                />
                <CardPill icon="📋" label="Duplicate" onClick={() => duplicate(t.id)} disabled={busy} />
                <CardPill icon="🗑️" label="Delete" onClick={() => remove(t)} disabled={busy} />
              </>
            )}
            onOpen={(t) => setEditing(t.id)}
          />

          <Group
            title="Global plans"
            empty="No global plans have been published yet."
            items={global}
            badge="Read-only"
            renderActions={(t) => (
              <>
                <CardPill icon="🗂️" label="View" onClick={() => setViewing(t.id)} />
                <CardPill icon="🔗" label="Share" onClick={() => setSharing(t)} />
                <CardPill icon="📋" label="Duplicate" onClick={() => duplicate(t.id)} disabled={busy} />
              </>
            )}
            onOpen={(t) => setViewing(t.id)}
          />
        </div>
      )}

      {sharing && <ShareModal template={sharing} onClose={() => setSharing(null)} />}
      {submitting && <SubmitModal template={submitting} onClose={() => setSubmitting(null)} />}
    </section>
  );
}

function ShareModal({
  template,
  onClose,
}: {
  template: CoachingTemplate;
  onClose: () => void;
}) {
  const [coaches, setCoaches] = useState<{ id: number; full_name: string }[]>([]);
  const [recipientId, setRecipientId] = useState<number | "">("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ coaches: { id: number; full_name: string }[] }>("/api/coach/coaches")
      .then((d) => setCoaches(d.coaches))
      .catch(() => setCoaches([]))
      .finally(() => setLoading(false));
  }, []);

  const send = async () => {
    if (recipientId === "") {
      setErr("Choose a coach to share with.");
      return;
    }
    setSending(true);
    setErr(null);
    try {
      await apiFetch(`${COACH_BASE}/${template.id}/share`, {
        method: "POST",
        body: { recipientId, message },
      });
      setDone(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to share");
    } finally {
      setSending(false);
    }
  };

  return (
    <ModalShell title={`Share "${template.name}"`} onClose={onClose}>
      {done ? (
        <div className="space-y-4">
          <p className="text-sm text-dewey-ink">
            Shared. The coach will find it in their Message Center.
          </p>
          <div className="flex justify-end">
            <button type="button" className="dewey-btn-primary w-auto" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {err && <p className="text-sm text-red-600">{err}</p>}
          <div>
            <label className="dewey-label">Coach</label>
            {loading ? (
              <p className="text-sm text-dewey-mute">Loading coaches…</p>
            ) : coaches.length === 0 ? (
              <p className="text-sm text-dewey-mute">No other coaches in your district.</p>
            ) : (
              <select
                className="dewey-input"
                value={recipientId}
                onChange={(e) => setRecipientId(e.target.value ? Number(e.target.value) : "")}
              >
                <option value="">— choose a coach —</option>
                {coaches.map((c) => (
                  <option key={c.id} value={c.id}>{c.full_name}</option>
                ))}
              </select>
            )}
          </div>
          <div>
            <label className="dewey-label">Message (optional)</label>
            <textarea
              className="dewey-input min-h-[80px]"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Add a note for them…"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" className="dewey-btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="dewey-btn-primary w-auto"
              onClick={send}
              disabled={sending || coaches.length === 0}
            >
              {sending ? "Sharing…" : "Share"}
            </button>
          </div>
        </div>
      )}
    </ModalShell>
  );
}

function SubmitModal({
  template,
  onClose,
}: {
  template: CoachingTemplate;
  onClose: () => void;
}) {
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const send = async () => {
    setSending(true);
    setErr(null);
    try {
      await apiFetch(`${COACH_BASE}/${template.id}/submit`, {
        method: "POST",
        body: { message },
      });
      setDone(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to submit");
    } finally {
      setSending(false);
    }
  };

  return (
    <ModalShell title={`Submit "${template.name}"`} onClose={onClose}>
      {done ? (
        <div className="space-y-4">
          <p className="text-sm text-dewey-ink">
            Submitted for district-wide consideration. You&apos;ll get the admin&apos;s decision in
            your Message Center.
          </p>
          <div className="flex justify-end">
            <button type="button" className="dewey-btn-primary w-auto" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {err && <p className="text-sm text-red-600">{err}</p>}
          <p className="text-sm text-dewey-mute">
            Submitting sends this plan to the admin to review for use as a district-wide
            plan. If approved, it becomes available to all coaches.
          </p>
          <div>
            <label className="dewey-label">Message to the admin (optional)</label>
            <textarea
              className="dewey-input min-h-[80px]"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Why this plan is worth sharing district-wide…"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" className="dewey-btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="dewey-btn-primary w-auto"
              onClick={send}
              disabled={sending}
            >
              {sending ? "Submitting…" : "Submit"}
            </button>
          </div>
        </div>
      )}
    </ModalShell>
  );
}

function ModalShell({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg bg-dewey-surface p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-4 text-lg font-semibold">{title}</h3>
        {children}
      </div>
    </div>
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
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{t.name}</span>
                  {badge && (
                    <span className="rounded bg-dewey-surface-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-dewey-mute">
                      {badge}
                    </span>
                  )}
                  {t.submission_status && (
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                        t.submission_status === "approved"
                          ? "bg-green-100 text-green-800"
                          : t.submission_status === "rejected"
                          ? "bg-red-100 text-red-700"
                          : "bg-amber-100 text-amber-800"
                      }`}
                      title="District-submission status"
                    >
                      {t.submission_status === "approved"
                        ? "Approved"
                        : t.submission_status === "rejected"
                        ? "Rejected"
                        : "Pending review"}
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
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                {renderActions(t)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
