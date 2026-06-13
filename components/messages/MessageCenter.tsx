"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import ReactMarkdown from "react-markdown";
import { useSession } from "next-auth/react";
import { apiFetch } from "@/lib/api-client";
import { pathWithBase } from "@/lib/base-path";
import { useDialog } from "@/components/DialogProvider";
import { Avatar } from "@/components/Avatar";

// Loaded only when a partnership plan is opened/edited (React Flow is heavy).
const TemplateCanvas = dynamic(
  () => import("@/components/admin/TemplateCanvas").then((m) => m.TemplateCanvas),
  { ssr: false }
);
const TemplateReadOnly = dynamic(
  () => import("@/components/admin/TemplateCanvas").then((m) => m.TemplateReadOnly),
  { ssr: false }
);

type Participant = { id: number; full_name: string; system_role: string };
type AttachmentMeta = { id: number; filename: string; mime_type: string; size_bytes: number };
type MessageView = {
  id: number;
  sender_id: number | null;
  sender_name: string | null;
  body: string;
  created_at: string;
  attachments: AttachmentMeta[];
  plan_id: number | null;
  plan_name: string | null;
  plan_phase: string | null;
  is_ai: boolean;
  reply_to: number | null;
  reply_excerpt: string | null;
  reply_sender: string | null;
};
type ThreadSummary = {
  id: number;
  kind: string;
  subject: string | null;
  template_id: number | null;
  template_name: string | null;
  status: "open" | "approved" | "rejected" | "done" | "abandoned" | null;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  participants: Participant[];
  last_message: { body: string; created_at: string; sender_name: string | null } | null;
  message_count: number;
  unread: boolean;
};

type Invitation = {
  thread_id: number;
  coach_name: string | null;
  member_names: string[];
  created_at: string;
};

type ReplyTarget = { id: number; sender: string; excerpt: string; isAi: boolean };

const STATUS_BADGE: Record<string, string> = {
  open: "bg-amber-100 text-amber-800",
  approved: "bg-green-100 text-green-800",
  rejected: "bg-red-100 text-red-700",
  done: "bg-green-100 text-green-800",
  abandoned: "bg-dewey-surface-2 text-dewey-mute",
};

function attachmentUrl(id: number) {
  return pathWithBase(`/api/messages/attachments/${id}`);
}

/**
 * Shared message center for coaches and admins. Two panes: a thread list and the
 * active conversation with a composer that supports file attachments (images and
 * PDFs preview inline). Admins see every thread for oversight.
 */
export function MessageCenter() {
  const { data: session } = useSession();
  const meId = session?.user?.id ? Number(session.user.id) : null;

  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [preview, setPreview] = useState<AttachmentMeta | null>(null);
  const [composing, setComposing] = useState(false);
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [invitations, setInvitations] = useState<Invitation[]>([]);

  const loadThreads = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set("q", search.trim());
      if (showArchived) params.set("archived", "1");
      const qs = params.toString();
      const [d, inv] = await Promise.all([
        apiFetch<{ threads: ThreadSummary[]; isAdmin: boolean }>(
          `/api/messages/threads${qs ? `?${qs}` : ""}`
        ),
        apiFetch<{ invitations: Invitation[] }>("/api/messages/invitations").catch(() => ({
          invitations: [] as Invitation[],
        })),
      ]);
      setInvitations(inv.invitations ?? []);
      setThreads(d.threads);
      setIsAdmin(d.isAdmin);
      setError(null);
      // Keep selection valid; default to the first thread.
      setActiveId((cur) =>
        cur && d.threads.some((t) => t.id === cur) ? cur : d.threads[0]?.id ?? null
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load messages");
    } finally {
      setLoading(false);
    }
  }, [search, showArchived]);

  // Warm the AI models so the first @dewey reply isn't a cold start.
  useEffect(() => {
    fetch(pathWithBase("/api/admin/ai/warmup"), { method: "POST" }).catch(() => {});
  }, []);

  // Reload (debounced) when the search or archived view changes, and poll.
  useEffect(() => {
    const t = setTimeout(() => loadThreads(), 200);
    return () => clearTimeout(t);
  }, [loadThreads]);

  useEffect(() => {
    const t = setInterval(() => loadThreads(), 6000);
    return () => clearInterval(t);
  }, [loadThreads]);

  const onComposed = useCallback(
    async (threadId: number) => {
      setComposing(false);
      await loadThreads();
      setActiveId(threadId);
    },
    [loadThreads]
  );

  const respondInvite = useCallback(
    async (threadId: number, accept: boolean) => {
      try {
        await fetch(pathWithBase(`/api/messages/threads/${threadId}/respond`), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accept }),
        });
      } catch {
        /* ignore */
      }
      await loadThreads();
      if (accept) setActiveId(threadId);
    },
    [loadThreads]
  );

  return (
    // Full-bleed: break out of the centered max-w container so the messenger is
    // much wider than the other tabs.
    <section className="relative left-1/2 w-[94vw] max-w-[1400px] -translate-x-1/2">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">Messages</h2>
          {isAdmin && (
            <span className="rounded bg-dewey-surface-2 px-1.5 py-0.5 text-[10px] uppercase text-dewey-mute">
              All conversations
            </span>
          )}
        </div>
        <button
          type="button"
          className="dewey-btn-secondary shrink-0"
          onClick={() => setComposing(true)}
        >
          + New message
        </button>
      </div>

      {invitations.length > 0 && (
        <div className="mb-3 space-y-2">
          {invitations.map((inv) => (
            <div
              key={inv.thread_id}
              className="flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2"
            >
              <div className="min-w-0 text-sm text-amber-900">
                <span className="font-medium">{inv.coach_name ?? "A coach"}</span> invited you to a
                partnership
                {inv.member_names.length > 1 && (
                  <span className="text-amber-800"> with {inv.member_names.join(", ")}</span>
                )}
                .
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  className="rounded-md bg-green-600 px-3 py-1 text-xs font-medium text-white hover:bg-green-700"
                  onClick={() => respondInvite(inv.thread_id, true)}
                >
                  Accept
                </button>
                <button
                  type="button"
                  className="rounded-md border border-amber-300 px-3 py-1 text-xs text-amber-900 hover:bg-amber-100"
                  onClick={() => respondInvite(inv.thread_id, false)}
                >
                  Decline
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {error ? (
        <p className="text-red-600">{error}</p>
      ) : (
        <div className="flex h-[78vh] overflow-hidden rounded-lg border border-dewey-border">
          <div className="flex w-72 shrink-0 flex-col border-r border-dewey-border bg-dewey-surface">
            {/* List controls: search + inbox/archived toggle */}
            <div className="space-y-2 border-b border-dewey-border p-2">
              <input
                type="search"
                className="dewey-input"
                placeholder="Search people or messages…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <div className="flex gap-1 text-xs">
                <button
                  type="button"
                  onClick={() => setShowArchived(false)}
                  className={`flex-1 rounded px-2 py-1 ${
                    !showArchived
                      ? "bg-dewey-surface-2 font-medium text-dewey-ink"
                      : "text-dewey-mute hover:text-dewey-ink"
                  }`}
                >
                  Inbox
                </button>
                <button
                  type="button"
                  onClick={() => setShowArchived(true)}
                  className={`flex-1 rounded px-2 py-1 ${
                    showArchived
                      ? "bg-dewey-surface-2 font-medium text-dewey-ink"
                      : "text-dewey-mute hover:text-dewey-ink"
                  }`}
                >
                  Archived
                </button>
              </div>
            </div>
            <ul className="flex-1 divide-y divide-dewey-border overflow-y-auto">
              {loading ? (
                <li className="px-3 py-3 text-xs text-dewey-mute">Loading…</li>
              ) : threads.length === 0 ? (
                <li className="px-3 py-4 text-center text-xs text-dewey-mute">
                  {search.trim()
                    ? "No matches."
                    : showArchived
                    ? "No archived conversations."
                    : "No conversations yet."}
                </li>
              ) : (
                threads.map((t) => (
                  <ThreadListItem
                    key={t.id}
                    thread={t}
                    meId={meId}
                    active={t.id === activeId}
                    onSelect={() => setActiveId(t.id)}
                  />
                ))
              )}
            </ul>
          </div>
          <div className="flex min-w-0 flex-1 flex-col bg-dewey-cream">
            {activeId == null ? (
              <div className="flex flex-1 items-center justify-center text-sm text-dewey-mute">
                Select a conversation.
              </div>
            ) : (
              <ThreadPane
                key={activeId}
                threadId={activeId}
                meId={meId}
                archived={showArchived}
                isAdmin={isAdmin}
                onPreview={setPreview}
                onPosted={loadThreads}
                onArchived={() => {
                  setActiveId(null);
                  loadThreads();
                }}
              />
            )}
          </div>
        </div>
      )}

      {preview && <AttachmentLightbox attachment={preview} onClose={() => setPreview(null)} />}
      {composing && (
        <ComposeModal onClose={() => setComposing(false)} onSent={onComposed} />
      )}
    </section>
  );
}

type Recipient = {
  id: number;
  full_name: string;
  username: string;
  system_role: string;
  district_name: string | null;
  school_names: string[];
};

/** Start a new direct message to an allowed recipient. */
function ComposeModal({
  onClose,
  onSent,
}: {
  onClose: () => void;
  onSent: (threadId: number) => void;
}) {
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [selected, setSelected] = useState<Recipient[]>([]);
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ recipients: Recipient[] }>("/api/messages/recipients")
      .then((d) => setRecipients(d.recipients))
      .catch(() => setRecipients([]))
      .finally(() => setLoading(false));
  }, []);

  const orgLabel = (r: Recipient) =>
    r.school_names.length > 0
      ? `${r.district_name} · ${r.school_names.join(", ")}`
      : r.district_name
      ? r.district_name
      : "";

  // Live search by name or username, excluding already-selected people.
  const q = query.trim().toLowerCase();
  const selectedIds = new Set(selected.map((r) => r.id));
  const matches = recipients
    .filter((r) => !selectedIds.has(r.id))
    .filter((r) =>
      q ? `${r.full_name} ${r.username}`.toLowerCase().includes(q) : true
    )
    .slice(0, 8);

  const add = (r: Recipient) => {
    setSelected((cur) => [...cur, r]);
    setQuery("");
  };
  const remove = (id: number) => setSelected((cur) => cur.filter((r) => r.id !== id));

  const send = async () => {
    if (selected.length === 0) {
      setErr("Add at least one recipient.");
      return;
    }
    if (!message.trim()) {
      setErr("Write a message.");
      return;
    }
    setSending(true);
    setErr(null);
    try {
      const d = await apiFetch<{ threadId: number }>("/api/messages/threads", {
        method: "POST",
        body: { recipientIds: selected.map((r) => r.id), message },
      });
      onSent(d.threadId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to send");
      setSending(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg bg-dewey-surface p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-4 text-lg font-semibold">New message</h3>
        <div className="space-y-4">
          {err && <p className="text-sm text-red-600">{err}</p>}

          <div>
            <label className="dewey-label">To</label>
            {/* Selected recipient chips */}
            {selected.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {selected.map((r) => (
                  <span
                    key={r.id}
                    className="flex items-center gap-1 rounded-full border border-dewey-border bg-dewey-surface-2 py-0.5 pl-2 pr-1 text-xs"
                  >
                    {r.full_name}
                    <button
                      type="button"
                      className="text-dewey-mute hover:text-dewey-ink"
                      onClick={() => remove(r.id)}
                      aria-label={`Remove ${r.full_name}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            {loading ? (
              <p className="text-sm text-dewey-mute">Loading…</p>
            ) : recipients.length === 0 ? (
              <p className="text-sm text-dewey-mute">No one available to message yet.</p>
            ) : (
              <div className="relative">
                <input
                  className="dewey-input"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search by name or username…"
                  autoFocus
                />
                {query.trim() && (
                  <ul className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-md border border-dewey-border bg-dewey-surface shadow-lg">
                    {matches.length === 0 ? (
                      <li className="px-3 py-2 text-xs text-dewey-mute">No matches.</li>
                    ) : (
                      matches.map((r) => (
                        <li key={r.id}>
                          <button
                            type="button"
                            className="block w-full px-3 py-2 text-left text-sm hover:bg-dewey-surface-2"
                            onClick={() => add(r)}
                          >
                            <span className="font-medium text-dewey-ink">{r.full_name}</span>
                            <span className="ml-1 text-xs text-dewey-mute">
                              @{r.username} · {r.system_role}
                              {orgLabel(r) ? ` · ${orgLabel(r)}` : ""}
                            </span>
                          </button>
                        </li>
                      ))
                    )}
                  </ul>
                )}
              </div>
            )}
          </div>

          <div>
            <label className="dewey-label">Message</label>
            <textarea
              className="dewey-input min-h-[100px]"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Write your message…"
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
              disabled={sending || loading || selected.length === 0}
            >
              {sending ? "Sending…" : "Send"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Compact last-message timestamp: time today, else a short date. */
function formatLastTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

function threadTitle(t: ThreadSummary, meId: number | null): string {
  if (t.subject) return t.subject;
  const others = t.participants.filter((p) => p.id !== meId).map((p) => p.full_name);
  return others.length ? others.join(", ") : "Conversation";
}

function ThreadListItem({
  thread: t,
  meId,
  active,
  onSelect,
}: {
  thread: ThreadSummary;
  meId: number | null;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={`block w-full px-3 py-2 text-left ${
          active ? "bg-dewey-surface-2" : "hover:bg-dewey-surface-2"
        }`}
      >
        <div className="flex items-center justify-between gap-2">
          <span
            className={`flex min-w-0 items-center gap-1.5 truncate text-sm text-dewey-ink ${
              t.unread ? "font-semibold" : "font-medium"
            }`}
          >
            {t.unread && (
              <span className="h-2 w-2 shrink-0 rounded-full bg-dewey-accent" aria-label="unread" />
            )}
            <span className="truncate">{threadTitle(t, meId)}</span>
          </span>
          {t.status && (
            <span
              className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase ${
                STATUS_BADGE[t.status] ?? "bg-dewey-surface-2 text-dewey-mute"
              }`}
            >
              {t.status}
            </span>
          )}
        </div>
        {t.last_message && (
          <>
            <div
              className={`mt-0.5 truncate text-xs ${
                t.unread ? "text-dewey-ink" : "text-dewey-mute"
              }`}
            >
              {t.last_message.sender_name && (
                <span className="font-medium">{t.last_message.sender_name}: </span>
              )}
              {t.last_message.body}
            </div>
            <div className="mt-0.5 text-[10px] text-dewey-mute">
              {formatLastTime(t.last_message.created_at)}
            </div>
          </>
        )}
      </button>
    </li>
  );
}

export function ThreadPane({
  threadId,
  meId,
  archived,
  isAdmin = false,
  onPreview,
  onPosted,
  onArchived,
}: {
  threadId: number;
  meId: number | null;
  archived: boolean;
  isAdmin?: boolean;
  onPreview: (a: AttachmentMeta) => void;
  onPosted: () => void;
  onArchived: () => void;
}) {
  const dialog = useDialog();
  const [thread, setThread] = useState<ThreadSummary | null>(null);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [loading, setLoading] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Only auto-scroll on new messages when already near the bottom.
  const stick = useRef(true);
  // Show a typing indicator while an @dewey reply is being generated.
  const [deweyThinking, setDeweyThinking] = useState(false);
  // iMessage-style reply target.
  const [replyTarget, setReplyTarget] = useState<ReplyTarget | null>(null);
  // Partnership-plan UI.
  const [picking, setPicking] = useState(false);
  const [openPlan, setOpenPlan] = useState<{ id: number; name: string; phase: string | null } | null>(
    null
  );
  const isPartnership = thread?.kind === "partnership";
  const amCoach = isPartnership && thread?.created_by === meId;
  // Coach or admin may manage a partnership's lifecycle (done/abandon/archive).
  const canManage = isPartnership && (amCoach || isAdmin);
  const ended = thread?.status === "done" || thread?.status === "abandoned";

  const toggleArchive = async () => {
    if (
      !archived &&
      !(await dialog.confirm("Archive this conversation?", {
        title: "Archive",
        confirmText: "Archive",
      }))
    )
      return;
    try {
      const res = await fetch(pathWithBase(`/api/messages/threads/${threadId}/archive`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ archived: !archived }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error((d as { error?: string }).error || "Couldn't archive");
      }
      onArchived();
    } catch (e) {
      dialog.alert(e instanceof Error ? e.message : "Couldn't update the conversation.");
    }
  };

  const setPartnershipStatus = async (status: "done" | "abandoned" | "active") => {
    const labels: Record<string, string> = {
      done: "Mark this partnership as done?",
      abandoned: "Mark this partnership as abandoned?",
      active: "Reopen this partnership?",
    };
    if (!(await dialog.confirm(labels[status], { title: "Partnership status" }))) return;
    try {
      const res = await fetch(pathWithBase(`/api/messages/threads/${threadId}/partnership-status`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error((d as { error?: string }).error || "Couldn't update status");
      }
      fetchThread(false);
    } catch (e) {
      dialog.alert(e instanceof Error ? e.message : "Couldn't update the partnership.");
    }
  };

  const fetchThread = useCallback(
    async (showSpinner: boolean) => {
      if (showSpinner) setLoading(true);
      try {
        const d = await apiFetch<{ thread: ThreadSummary; messages: MessageView[] }>(
          `/api/messages/threads/${threadId}`
        );
        setThread(d.thread);
        setMessages(d.messages);
      } catch {
        if (showSpinner) {
          setThread(null);
          setMessages([]);
        }
      } finally {
        if (showSpinner) setLoading(false);
      }
    },
    [threadId]
  );

  useEffect(() => {
    stick.current = true; // jump to bottom when switching threads
    fetchThread(true);
  }, [fetchThread]);

  // Poll for new messages in the open thread (silent — no spinner).
  useEffect(() => {
    const t = setInterval(() => fetchThread(false), 4000);
    return () => clearInterval(t);
  }, [fetchThread]);

  // Keep the newest message (or the typing bubble) in view, unless scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, deweyThinking]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const onSent = useCallback(() => {
    stick.current = true;
    fetchThread(false);
    onPosted();
  }, [fetchThread, onPosted]);

  const dismissPlan = useCallback(
    async (messageId: number) => {
      if (!(await dialog.confirm("Dismiss this plan from the conversation?", { title: "Dismiss plan" })))
        return;
      try {
        await fetch(pathWithBase(`/api/messages/threads/${threadId}/dismiss-plan`), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messageId }),
        });
        fetchThread(false);
      } catch {
        dialog.alert("Couldn't dismiss the plan.");
      }
    },
    [dialog, threadId, fetchThread]
  );

  return (
    <>
      <div className="border-b border-dewey-border bg-dewey-surface px-4 py-2">
        <div className="flex items-center gap-2">
          <h3 className="truncate text-sm font-semibold text-dewey-ink">
            {thread ? threadTitle(thread, meId) : "…"}
          </h3>
          {thread?.status && (
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${
                STATUS_BADGE[thread.status] ?? "bg-dewey-surface-2 text-dewey-mute"
              }`}
            >
              {thread.status}
            </span>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-3">
            {amCoach && !ended && (
              <button
                type="button"
                className="text-xs text-dewey-accent hover:underline"
                onClick={() => setPicking(true)}
              >
                + Add plan
              </button>
            )}
            {/* Partnership lifecycle (coach or admin). */}
            {canManage && !ended && (
              <>
                <button
                  type="button"
                  className="text-xs text-dewey-accent hover:underline"
                  onClick={() => setPartnershipStatus("done")}
                >
                  Mark done
                </button>
                <button
                  type="button"
                  className="text-xs text-dewey-mute hover:text-dewey-ink"
                  onClick={() => setPartnershipStatus("abandoned")}
                >
                  Abandon
                </button>
              </>
            )}
            {canManage && ended && !archived && (
              <button
                type="button"
                className="text-xs text-dewey-accent hover:underline"
                onClick={() => setPartnershipStatus("active")}
              >
                Reopen
              </button>
            )}
            {/* Archive: non-partnership = anyone; partnership = coach/admin, only
                once it's ended (or to unarchive). */}
            {(!isPartnership || (canManage && (ended || archived))) && (
              <button
                type="button"
                className="text-xs text-dewey-accent hover:underline"
                onClick={toggleArchive}
              >
                {archived ? "Unarchive" : "Archive"}
              </button>
            )}
          </div>
        </div>
        {thread && thread.participants.length > 0 && (
          <p className="truncate text-xs text-dewey-mute">
            {thread.participants.map((p) => p.full_name).join(", ")}
          </p>
        )}
      </div>

      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto px-4 py-3">
        {/* min-h-full + justify-end anchors a short conversation to the bottom so
            the pane reads as filled, while long threads scroll normally. */}
        <div className="flex min-h-full flex-col justify-end gap-3">
          {loading ? (
            <p className="text-xs text-dewey-mute">Loading…</p>
          ) : messages.length === 0 ? (
            <p className="text-xs text-dewey-mute">No messages yet.</p>
          ) : (
            messages.map((m) => (
              <MessageBubble
                key={m.id}
                message={m}
                mine={m.sender_id === meId}
                amCoach={!!amCoach}
                onPreview={onPreview}
                onOpenPlan={(p) => setOpenPlan(p)}
                onDismissPlan={dismissPlan}
                onReply={(t) => setReplyTarget(t)}
              />
            ))
          )}
          {deweyThinking && (
            <div className="flex justify-start">
              <div className="max-w-[min(75%,620px)]">
                <div className="mb-0.5 flex items-center gap-1.5 text-[11px] text-dewey-mute">
                  <span className="inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-dewey-accent/20 text-[11px]">
                    🤖
                  </span>
                  <span className="font-medium text-dewey-ink">@dewey</span>
                </div>
                <div className="rounded-lg border border-dewey-border bg-dewey-accent/10 px-3 py-2">
                  <span className="typing-dots" aria-label="@dewey is typing">
                    <span />
                    <span />
                    <span />
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {thread?.kind === "compliance" ? (
        <div className="border-t border-dewey-border bg-dewey-surface px-4 py-3 text-center text-xs text-dewey-mute">
          System notice — replies are disabled.
        </div>
      ) : (
        <Composer
          threadId={threadId}
          replyTarget={replyTarget}
          onClearReply={() => setReplyTarget(null)}
          onSent={() => {
            setReplyTarget(null);
            onSent();
          }}
          onRefresh={() => fetchThread(false)}
          onDeweyPending={(pending) => {
            setDeweyThinking(pending);
            if (pending) stick.current = true;
          }}
        />
      )}

      {picking && (
        <AddPlanModal
          threadId={threadId}
          onClose={() => setPicking(false)}
          onAdded={() => {
            setPicking(false);
            fetchThread(false);
          }}
        />
      )}
      {openPlan && (
        <PlanModal
          plan={openPlan}
          amCoach={!!amCoach}
          onClose={() => setOpenPlan(null)}
          onChanged={() => fetchThread(false)}
        />
      )}
    </>
  );
}

function MessageBubble({
  message: m,
  mine,
  amCoach,
  onPreview,
  onOpenPlan,
  onDismissPlan,
  onReply,
}: {
  message: MessageView;
  mine: boolean;
  amCoach: boolean;
  onPreview: (a: AttachmentMeta) => void;
  onOpenPlan: (p: { id: number; name: string; phase: string | null }) => void;
  onDismissPlan: (messageId: number) => void;
  onReply: (t: ReplyTarget) => void;
}) {
  const senderLabel = m.is_ai ? "@dewey" : m.sender_name ?? "Unknown";
  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div className={`flex max-w-[min(75%,620px)] flex-col ${mine ? "items-end" : "items-start"}`}>
        <div className="mb-0.5 flex items-center gap-1.5 text-[11px] text-dewey-mute">
          {m.is_ai ? (
            <span className="inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-dewey-accent/20 text-[11px]">
              🤖
            </span>
          ) : (
            <Avatar userId={m.sender_id} name={m.sender_name} size={18} />
          )}
          <span className="font-medium text-dewey-ink">{senderLabel}</span>
          <span>{new Date(m.created_at).toLocaleString()}</span>
        </div>
        {/* Quoted reply target (iMessage-style). */}
        {m.reply_to != null && m.reply_excerpt != null && (
          <div className="mb-1 max-w-full truncate rounded-md border-l-2 border-dewey-accent/50 bg-dewey-surface-2 px-2 py-1 text-[11px] text-dewey-mute">
            <span className="font-medium text-dewey-ink">↩ {m.reply_sender}: </span>
            {m.reply_excerpt}
          </div>
        )}
        {m.plan_id != null ? (
          // Specialized plan bubble.
          <div className="rounded-lg border border-dewey-accent/40 bg-dewey-accent/5 p-3">
            <div className="flex items-center gap-2">
              <span className="text-lg">🗂️</span>
              <div className="min-w-0">
                <div className="text-xs uppercase tracking-wide text-dewey-mute">Coaching plan</div>
                <button
                  type="button"
                  className="truncate text-left text-sm font-semibold text-dewey-ink hover:underline"
                  onClick={() =>
                    onOpenPlan({ id: m.plan_id as number, name: m.plan_name ?? "Plan", phase: m.plan_phase })
                  }
                >
                  {m.plan_name ?? "Plan"}
                </button>
              </div>
            </div>
            <div className="mt-2 flex items-center gap-3">
              <button
                type="button"
                className="text-xs text-dewey-accent hover:underline"
                onClick={() =>
                  onOpenPlan({ id: m.plan_id as number, name: m.plan_name ?? "Plan", phase: m.plan_phase })
                }
              >
                View plan ↗
              </button>
              {amCoach && (
                <button
                  type="button"
                  className="text-xs text-red-700 hover:underline"
                  onClick={() => onDismissPlan(m.id)}
                >
                  Dismiss
                </button>
              )}
            </div>
          </div>
        ) : (
          <div
            className={`rounded-lg px-3 py-2 text-sm ${
              m.is_ai
                ? "bg-dewey-accent/10 text-dewey-ink"
                : mine
                ? "bg-dewey-accent/15 text-dewey-ink"
                : "bg-dewey-surface text-dewey-ink"
            } border border-dewey-border`}
          >
            {m.body &&
              (m.is_ai ? (
                <div className="chat-md text-sm">
                  <ReactMarkdown>{m.body}</ReactMarkdown>
                </div>
              ) : (
                <p className="whitespace-pre-wrap">{m.body}</p>
              ))}
            {m.attachments.length > 0 && (
              <div className="mt-2 space-y-2">
                {m.attachments.map((a) => (
                  <Attachment key={a.id} att={a} onPreview={onPreview} />
                ))}
              </div>
            )}
          </div>
        )}
        {/* Reply link beneath messages from others (incl. @dewey). */}
        {!mine && (
          <button
            type="button"
            className="mt-0.5 text-[11px] text-dewey-mute hover:text-dewey-accent"
            onClick={() =>
              onReply({
                id: m.id,
                sender: senderLabel,
                excerpt: (m.body || (m.plan_id ? `Plan: ${m.plan_name ?? ""}` : "")).slice(0, 120),
                isAi: m.is_ai,
              })
            }
          >
            {m.is_ai ? "Reply to @dewey" : "Reply"}
          </button>
        )}
      </div>
    </div>
  );
}

function Attachment({
  att,
  onPreview,
}: {
  att: AttachmentMeta;
  onPreview: (a: AttachmentMeta) => void;
}) {
  const url = attachmentUrl(att.id);
  const isImage = att.mime_type.startsWith("image/");
  const isPdf = att.mime_type === "application/pdf";

  if (isImage) {
    return (
      <button type="button" onClick={() => onPreview(att)} className="block">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt={att.filename}
          className="max-h-48 max-w-full rounded border border-dewey-border"
        />
      </button>
    );
  }
  if (isPdf) {
    return (
      <button
        type="button"
        onClick={() => onPreview(att)}
        className="flex items-center gap-2 rounded border border-dewey-border bg-dewey-surface-2 px-2 py-1 text-xs text-dewey-accent hover:underline"
      >
        📄 {att.filename}
      </button>
    );
  }
  return (
    <a
      href={url}
      download={att.filename}
      className="flex items-center gap-2 rounded border border-dewey-border bg-dewey-surface-2 px-2 py-1 text-xs text-dewey-accent hover:underline"
    >
      ⬇ {att.filename}
    </a>
  );
}

type AddableUser = { id: number; full_name: string; username: string; system_role: string };

function Composer({
  threadId,
  replyTarget,
  onClearReply,
  onSent,
  onRefresh,
  onDeweyPending,
}: {
  threadId: number;
  replyTarget: ReplyTarget | null;
  onClearReply: () => void;
  onSent: () => void;
  onRefresh: () => void;
  onDeweyPending: (pending: boolean) => void;
}) {
  const dialog = useDialog();
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  // @-mention: when the word at the caret starts with "@", search addable users.
  const [mention, setMention] = useState<string | null>(null);
  const [matches, setMatches] = useState<AddableUser[]>([]);

  useEffect(() => {
    if (mention === null) {
      setMatches([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      fetch(pathWithBase(`/api/messages/threads/${threadId}/addable?q=${encodeURIComponent(mention)}`))
        .then((r) => (r.ok ? r.json() : { users: [] }))
        .then((d) => {
          if (!cancelled) setMatches(d.users ?? []);
        })
        .catch(() => {
          if (!cancelled) setMatches([]);
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [mention, threadId]);

  const onBodyChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    setBody(v);
    const caret = e.target.selectionStart ?? v.length;
    const m = /(^|\s)@(\w*)$/.exec(v.slice(0, caret));
    setMention(m ? m[2] : null);
  };

  const pickMention = async (u: AddableUser) => {
    // Replace the partial "@word" before the caret with "@username ".
    const el = textRef.current;
    const caret = el?.selectionStart ?? body.length;
    const before = body.slice(0, caret).replace(/@(\w*)$/, `@${u.username} `);
    setBody(before + body.slice(caret));
    setMention(null);
    setMatches([]);
    try {
      const res = await fetch(pathWithBase(`/api/messages/threads/${threadId}/participants`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: u.id }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error((d as { error?: string }).error || "Couldn't add");
      }
      onRefresh();
    } catch (e) {
      dialog.alert(e instanceof Error ? e.message : "Couldn't add that person");
    }
  };

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    setFiles((prev) => [...prev, ...Array.from(list)]);
    if (fileInput.current) fileInput.current.value = "";
  };

  const send = async () => {
    if (sending) return;
    if (!body.trim() && files.length === 0) return;
    // @dewey generates within the request, so show the typing indicator until
    // the response (which includes the AI reply) returns — also when replying
    // to an @dewey message (that's a prompt back to the AI).
    const willDewey = /(^|\s)@dewey\b/i.test(body) || replyTarget?.isAi === true;
    setSending(true);
    if (willDewey) onDeweyPending(true);
    try {
      const form = new FormData();
      form.append("body", body);
      if (replyTarget) form.append("replyTo", String(replyTarget.id));
      files.forEach((f) => form.append("files", f));
      const res = await fetch(pathWithBase(`/api/messages/threads/${threadId}/messages`), {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error((d as { error?: string }).error || `HTTP ${res.status}`);
      }
      setBody("");
      setFiles([]);
      onSent();
    } catch (e) {
      dialog.alert(e instanceof Error ? e.message : "Failed to send");
    } finally {
      setSending(false);
      if (willDewey) onDeweyPending(false);
    }
  };

  return (
    <div className="relative border-t border-dewey-border bg-dewey-surface px-3 py-2">
      {replyTarget && (
        <div className="mb-2 flex items-center justify-between gap-2 rounded-md border-l-2 border-dewey-accent/50 bg-dewey-surface-2 px-2 py-1 text-xs">
          <span className="min-w-0 truncate text-dewey-mute">
            <span className="font-medium text-dewey-ink">
              Replying to {replyTarget.sender}:{" "}
            </span>
            {replyTarget.excerpt}
          </span>
          <button
            type="button"
            className="shrink-0 text-dewey-mute hover:text-dewey-ink"
            onClick={onClearReply}
            aria-label="Cancel reply"
          >
            ×
          </button>
        </div>
      )}
      {mention !== null && matches.length > 0 && (
        <ul className="absolute bottom-full left-3 z-20 mb-1 max-h-56 w-72 overflow-y-auto rounded-md border border-dewey-border bg-dewey-surface shadow-lg">
          {matches.map((u) => (
            <li key={u.id}>
              <button
                type="button"
                className="block w-full px-3 py-2 text-left text-sm hover:bg-dewey-surface-2"
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickMention(u);
                }}
              >
                <span className="font-medium text-dewey-ink">{u.full_name}</span>
                <span className="ml-1 text-xs text-dewey-mute">@{u.username} · {u.system_role}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {files.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {files.map((f, i) => (
            <span
              key={i}
              className="flex items-center gap-1 rounded border border-dewey-border bg-dewey-surface-2 px-2 py-0.5 text-xs"
            >
              {f.name}
              <button
                type="button"
                className="text-dewey-mute hover:text-dewey-ink"
                onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                aria-label={`Remove ${f.name}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2">
        <button
          type="button"
          className="dewey-btn-secondary shrink-0"
          onClick={() => fileInput.current?.click()}
          title="Attach files"
        >
          📎
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => addFiles(e.target.files)}
        />
        <textarea
          ref={textRef}
          className="dewey-input min-h-[38px] flex-1 resize-none"
          rows={1}
          placeholder="Write a message…  @ to add someone"
          value={body}
          onChange={onBodyChange}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && mention === null) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button
          type="button"
          className="dewey-btn-primary w-auto shrink-0"
          onClick={send}
          disabled={sending}
        >
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
}

type PlanOption = { id: number; name: string; scope: string; description: string | null };

/** Coach picks one of their plans (personal or global) to embed in the chat. */
function AddPlanModal({
  threadId,
  onClose,
  onAdded,
}: {
  threadId: number;
  onClose: () => void;
  onAdded: () => void;
}) {
  const dialog = useDialog();
  const [plans, setPlans] = useState<PlanOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiFetch<{ templates: PlanOption[] }>("/api/coach/templates")
      .then((d) => setPlans(d.templates))
      .catch(() => setPlans([]))
      .finally(() => setLoading(false));
  }, []);

  const add = async (sourcePlanId: number) => {
    setBusy(true);
    try {
      const res = await fetch(pathWithBase(`/api/messages/threads/${threadId}/plan`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourcePlanId }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error((d as { error?: string }).error || "Couldn't add the plan");
      }
      onAdded();
    } catch (e) {
      dialog.alert(e instanceof Error ? e.message : "Couldn't add the plan");
      setBusy(false);
    }
  };

  const mine = plans.filter((p) => p.scope === "personal");
  const global = plans.filter((p) => p.scope === "global");

  return (
    <PlanShell title="Add a plan to this partnership" onClose={onClose}>
      <p className="mb-3 text-sm text-dewey-mute">
        A copy is embedded in the chat for everyone. It won&apos;t appear in your plan list.
      </p>
      {loading ? (
        <p className="text-sm text-dewey-mute">Loading…</p>
      ) : plans.length === 0 ? (
        <p className="text-sm text-dewey-mute">You have no plans to add yet.</p>
      ) : (
        <div className="space-y-4">
          {[
            { title: "My plans", items: mine },
            { title: "Global plans", items: global },
          ].map((group) =>
            group.items.length === 0 ? null : (
              <div key={group.title}>
                <h4 className="mb-1 text-xs font-semibold text-dewey-ink">{group.title}</h4>
                <ul className="divide-y divide-dewey-border rounded-md border border-dewey-border">
                  {group.items.map((p) => (
                    <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2">
                      <span className="min-w-0 truncate text-sm text-dewey-ink">{p.name}</span>
                      <button
                        type="button"
                        className="shrink-0 text-xs text-dewey-accent hover:underline disabled:opacity-50"
                        onClick={() => add(p.id)}
                        disabled={busy}
                      >
                        Add
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )
          )}
        </div>
      )}
    </PlanShell>
  );
}

/** Plan embedded in a partnership: coach edits the copy; partner sees the phase + read-only. */
function PlanModal({
  plan,
  amCoach,
  onClose,
  onChanged,
}: {
  plan: { id: number; name: string; phase: string | null };
  amCoach: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const dialog = useDialog();
  const [editing, setEditing] = useState(false);
  const [viewing, setViewing] = useState(false);
  const [copying, setCopying] = useState(false);

  const copyToMine = async () => {
    setCopying(true);
    try {
      await apiFetch(`/api/coach/templates/${plan.id}/duplicate`, { method: "POST" });
      await dialog.alert("Copied to your plans — find it under the Coaching Canvas.", {
        title: "Copied",
      });
    } catch (e) {
      dialog.alert(e instanceof Error ? e.message : "Couldn't copy the plan");
    } finally {
      setCopying(false);
    }
  };

  if (editing) {
    return (
      <TemplateCanvas
        templateId={plan.id}
        templatesBase="/api/coach/templates"
        onClose={() => {
          setEditing(false);
          onChanged();
        }}
      />
    );
  }
  if (viewing) {
    return (
      <TemplateReadOnly
        templateId={plan.id}
        templatesBase="/api/partnership-plans"
        onClose={() => setViewing(false)}
      />
    );
  }

  return (
    <PlanShell title={plan.name} onClose={onClose}>
      {amCoach ? (
        <div className="space-y-4">
          <p className="text-sm text-dewey-mute">
            Reporting and review for this plan will live here. For now you can edit this
            partnership&apos;s copy, or copy it back into your plan library.
          </p>
          <div className="rounded-md border border-dewey-border bg-dewey-surface-2 p-3 text-sm">
            <span className="text-dewey-mute">Current phase: </span>
            <span className="font-medium text-dewey-ink">{plan.phase ?? "Not set"}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="dewey-btn-primary w-auto"
              onClick={() => setViewing(true)}
            >
              View plan
            </button>
            <button type="button" className="dewey-btn-secondary" onClick={() => setEditing(true)}>
              Edit plan
            </button>
            <button
              type="button"
              className="dewey-btn-secondary"
              onClick={copyToMine}
              disabled={copying}
            >
              {copying ? "Copying…" : "Copy to my plans"}
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="rounded-md border border-dewey-border bg-dewey-surface-2 p-3 text-sm">
            <span className="text-dewey-mute">Current phase: </span>
            <span className="font-medium text-dewey-ink">{plan.phase ?? "Not set"}</span>
          </div>
          <button type="button" className="dewey-btn-secondary" onClick={() => setViewing(true)}>
            View plan (read-only)
          </button>
        </div>
      )}
    </PlanShell>
  );
}

function PlanShell({
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
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg bg-dewey-surface p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h3 className="truncate text-lg font-semibold">{title}</h3>
          <button
            type="button"
            className="shrink-0 text-sm text-dewey-mute hover:text-dewey-ink"
            onClick={onClose}
          >
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function AttachmentLightbox({
  attachment,
  onClose,
}: {
  attachment: AttachmentMeta;
  onClose: () => void;
}) {
  const url = useMemo(() => attachmentUrl(attachment.id), [attachment.id]);
  const isPdf = attachment.mime_type === "application/pdf";
  return (
    <div
      className="fixed inset-0 z-[70] flex flex-col items-center justify-center bg-black/80 p-4"
      onClick={onClose}
    >
      <div className="mb-2 flex w-full max-w-4xl items-center justify-between text-sm text-white">
        <span className="truncate">{attachment.filename}</span>
        <div className="flex items-center gap-3">
          <a
            href={url}
            download={attachment.filename}
            className="hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            Download
          </a>
          <button type="button" onClick={onClose} className="hover:underline">
            Close
          </button>
        </div>
      </div>
      <div className="max-h-[85vh] w-full max-w-4xl" onClick={(e) => e.stopPropagation()}>
        {isPdf ? (
          <iframe src={url} title={attachment.filename} className="h-[85vh] w-full rounded bg-white" />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={url}
            alt={attachment.filename}
            className="mx-auto max-h-[85vh] max-w-full rounded object-contain"
          />
        )}
      </div>
    </div>
  );
}
