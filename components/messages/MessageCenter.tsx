"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import ReactMarkdown from "react-markdown";
import { useSession } from "next-auth/react";
import { apiFetch } from "@/lib/api-client";
import { pathWithBase } from "@/lib/base-path";
import { useDialog } from "@/components/DialogProvider";
import { Avatar } from "@/components/Avatar";
import { sanitizeDocumentHtml } from "@/lib/html-sanitize";

// Loaded only when a partnership plan is opened/edited (React Flow is heavy).
const TemplateCanvas = dynamic(
  () => import("@/components/admin/TemplateCanvas").then((m) => m.TemplateCanvas),
  { ssr: false }
);
const TemplateReadOnly = dynamic(
  () => import("@/components/admin/TemplateCanvas").then((m) => m.TemplateReadOnly),
  { ssr: false }
);

type Participant = {
  id: number;
  full_name: string;
  nickname: string | null;
  system_role: string;
};
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
  plan_accepted: boolean;
  plan_deactivated: boolean;
  plan_owner_id: number | null;
  plan_accepted_by: number[];
  plan_participant_count: number;
  plan_outcome: "finished" | "abandoned" | null;
  is_ai: boolean;
  reply_to: number | null;
  reply_excerpt: string | null;
  reply_sender: string | null;
  sources: { name: string; path: string }[];
  submission_status: "pending" | "approved" | "returned" | null;
  restricted: boolean;
  event: "advance" | "finish" | null;
};
type ActiveActivity = {
  planId: number;
  planName: string;
  nodeId: string;
  nodeLabel: string;
  gating: "OPEN" | "REVIEWED";
  instructions: string;
  artifact: string;
  phaseId: string | null;
  phaseName: string | null;
  exitConditions: string | null;
  isLastInPhase: boolean;
  submission: {
    id: number;
    messageId: number | null;
    partnerId: number | null;
    status: "pending" | "approved" | "returned";
  } | null;
  pendingReview: boolean;
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
  accepted_plan_id: number | null;
  accepted_plan_name: string | null;
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

/** Display every case variant of the assistant mention (@Dewey, @DEWEY, …) as @dewey. */
function normalizeDeweyMention(body: string): string {
  return body.replace(/@dewey\b/gi, "@dewey");
}

/**
 * Shared message center for coaches and admins. Two panes: a thread list and the
 * active conversation with a composer that supports file attachments (images and
 * PDFs preview inline). Admins see every thread for oversight.
 */
export function MessageCenter({ openThreadId }: { openThreadId?: number | null } = {}) {
  const { data: session } = useSession();
  const meId = session?.user?.id ? Number(session.user.id) : null;

  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<number | null>(null);
  // Open a specific thread on request (e.g. from the coach dashboard).
  useEffect(() => {
    if (openThreadId != null) {
      setActiveId(openThreadId);
      setListCollapsed(false);
    }
  }, [openThreadId]);
  const [preview, setPreview] = useState<AttachmentMeta | null>(null);
  const [composing, setComposing] = useState(false);
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  // Collapse the left conversation list to give the chat more room.
  const [listCollapsed, setListCollapsed] = useState(false);

  // True vertical flex: measure the pane's top against the viewport and let it
  // fill the rest of the screen. This adapts to whatever sits above it (header,
  // tab bar, the impersonation band) instead of guessing a fixed offset.
  const paneRef = useRef<HTMLDivElement>(null);
  const [paneHeight, setPaneHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const el = paneRef.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      const vh = window.visualViewport?.height ?? window.innerHeight;
      // Leave room for the host's bottom padding (px-6 py-6 wrappers) so the page
      // itself never gains a sliver of scroll beneath the pane.
      setPaneHeight(Math.max(340, Math.floor(vh - top - 24)));
    };
    measure();
    // Re-measure after layout settles (async content above can shift the top).
    const t = setTimeout(measure, 120);
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    return () => {
      clearTimeout(t);
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
    };
  }, []);

  const loadThreads = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set("q", search.trim());
      if (showArchived) params.set("archived", "1");
      const qs = params.toString();
      const d = await apiFetch<{ threads: ThreadSummary[]; isAdmin: boolean }>(
        `/api/messages/threads${qs ? `?${qs}` : ""}`
      );
      setThreads(d.threads);
      setIsAdmin(d.isAdmin);
      setError(null);
      // Keep a valid selection. When nothing's selected, default to the first
      // thread only on desktop (two-pane) — on mobile, leave the list showing so
      // tapping "Back" doesn't get yanked into a thread by the next poll.
      setActiveId((cur) => {
        if (cur && d.threads.some((t) => t.id === cur)) return cur;
        const isDesktop =
          typeof window !== "undefined" && window.matchMedia("(min-width: 768px)").matches;
        return isDesktop ? d.threads[0]?.id ?? null : null;
      });
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


  return (
    // Full width on phones; on desktop, full-bleed out of the centered max-w
    // container so the messenger is much wider than the other tabs.
    <section className="relative w-full md:left-1/2 md:w-[94vw] md:max-w-[1400px] md:-translate-x-1/2">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">Messages</h2>
        </div>
        <button
          type="button"
          className="inline-flex shrink-0 items-center gap-1 rounded-full border border-dewey-accent/40 bg-dewey-accent/5 px-3 py-1 text-xs text-dewey-accent hover:bg-dewey-accent/10"
          onClick={() => setComposing(true)}
        >
          <span aria-hidden>✉️</span> New conversation
        </button>
      </div>

      {error ? (
        <p className="text-red-600">{error}</p>
      ) : (
        <div
          ref={paneRef}
          style={paneHeight ? { height: paneHeight } : undefined}
          className="flex h-[calc(100dvh-240px)] min-h-[340px] overflow-hidden rounded-lg border border-dewey-border"
        >
          {/* Desktop-only collapsed strip (the collapse feature doesn't apply on mobile). */}
          {listCollapsed && (
            <div className="hidden w-10 shrink-0 flex-col items-center border-r border-dewey-border bg-dewey-surface py-2 md:flex">
              <button
                type="button"
                onClick={() => setListCollapsed(false)}
                title="Show conversations"
                aria-label="Show conversations"
                className="rounded p-1 text-dewey-mute hover:bg-dewey-surface-2 hover:text-dewey-ink"
              >
                »
              </button>
            </div>
          )}
          {/* Conversation list. Mobile: full-width, shown only when no thread is
              open. Desktop: a fixed sidebar, hidden when collapsed. */}
          <div
            className={`${activeId == null ? "flex" : "hidden"} ${
              listCollapsed ? "md:hidden" : "md:flex"
            } w-full min-h-0 shrink-0 flex-col border-r border-dewey-border bg-dewey-surface md:w-72`}
          >
            {/* List controls: search + inbox/archived toggle */}
            <div className="space-y-2 border-b border-dewey-border p-2">
              <div className="flex items-center gap-2">
                <input
                  type="search"
                  className="dewey-input"
                  placeholder="Search people or messages…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <button
                  type="button"
                  onClick={() => setListCollapsed(true)}
                  title="Hide conversations"
                  aria-label="Hide conversations"
                  className="hidden shrink-0 rounded p-1 text-dewey-mute hover:bg-dewey-surface-2 hover:text-dewey-ink md:block"
                >
                  «
                </button>
              </div>
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
                  Active
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
          {/* Thread pane. Mobile: full-width, shown only when a thread is open.
              Desktop: fills the remaining space with a placeholder when idle. */}
          <div
            className={`${
              activeId == null ? "hidden md:flex" : "flex"
            } min-w-0 min-h-0 flex-1 flex-col bg-dewey-cream`}
          >
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
                iAmCoach={session?.user?.system_role === "coach"}
                onPreview={setPreview}
                onBack={() => setActiveId(null)}
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
        <h3 className="mb-4 text-lg font-semibold">New conversation</h3>
        <div className="space-y-4">
          {err && <p className="text-sm text-red-600">{err}</p>}

          <div>
            <label className="dewey-label">Include participants</label>
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

/**
 * Row of participant avatars with nicknames below; coaches are highlighted with
 * an accent ring + label so it's clear who's coaching.
 */
function ParticipantAvatars({
  participants,
  size,
}: {
  participants: Participant[];
  size: number;
}) {
  if (participants.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {participants.map((p) => {
        const isCoach = p.system_role === "coach";
        const name = p.nickname || p.full_name.split(" ")[0];
        return (
          <div key={p.id} className="flex w-14 flex-col items-center gap-0.5 text-center">
            <div className={isCoach ? "rounded-full ring-2 ring-dewey-accent ring-offset-1" : ""}>
              <Avatar userId={p.id} name={p.full_name} size={size} />
            </div>
            <span
              className={`max-w-full truncate text-[10px] leading-tight ${
                isCoach ? "font-semibold text-dewey-accent" : "text-dewey-mute"
              }`}
              title={p.full_name}
            >
              {name}
            </span>
            {isCoach && (
              <span className="text-[8px] font-medium uppercase tracking-wide text-dewey-accent">
                Coach
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
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
    <li
      className={`px-3 py-2 ${active ? "bg-dewey-surface-2" : "hover:bg-dewey-surface-2"}`}
    >
      <button type="button" onClick={onSelect} className="block w-full text-left">
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
        {t.participants.length > 0 && (
          <div className="mt-1.5">
            <ParticipantAvatars participants={t.participants} size={24} />
          </div>
        )}
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
  iAmCoach = false,
  onPreview,
  onBack,
  onPosted,
  onArchived,
}: {
  threadId: number;
  meId: number | null;
  archived: boolean;
  isAdmin?: boolean;
  iAmCoach?: boolean;
  onPreview: (a: AttachmentMeta) => void;
  /** Mobile: return to the conversation list. */
  onBack?: () => void;
  onPosted: () => void;
  onArchived: () => void;
}) {
  const dialog = useDialog();
  const [thread, setThread] = useState<ThreadSummary | null>(null);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [activeActivity, setActiveActivity] = useState<ActiveActivity | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [loading, setLoading] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Only auto-scroll on new messages when already near the bottom.
  const stick = useRef(true);
  // The user's last-read time when they opened the thread (captured once, server
  // marks read on open), used to scroll to / mark the first unread message.
  const [lastReadAt, setLastReadAt] = useState<string | null>(null);
  // First-open scroll-to-unread happens once per thread.
  const didInitialScroll = useRef(false);
  // Show a typing indicator while an @dewey reply is being generated.
  const [deweyThinking, setDeweyThinking] = useState(false);
  // iMessage-style reply target.
  const [replyTarget, setReplyTarget] = useState<ReplyTarget | null>(null);
  // Embedded-plan UI.
  const [picking, setPicking] = useState(false);
  const [viewPlanId, setViewPlanId] = useState<number | null>(null);
  // Open the plan straight to its current activity ("Current activity" pill).
  const [viewPlanFocus, setViewPlanFocus] = useState(false);
  const [editPlanId, setEditPlanId] = useState<number | null>(null);
  // A coach can add/manage plans in any thread they're in; coach or admin can rename.
  const canManage = iAmCoach || isAdmin;
  // A plan submission awaiting an admin decision.
  const submissionPending =
    thread?.kind === "template_submission" && (thread?.status == null || thread?.status === "open");
  // The most recent fully-accepted plan, surfaced as a header "View plan" link.
  const acceptedPlan = [...messages].reverse().find((m) => m.plan_id != null && m.plan_accepted);
  // Coach senders get the same accent ring in the message window as they do in
  // the thread list, so the coach's voice is easy to spot at a glance.
  const coachIds = new Set(
    (thread?.participants ?? []).filter((p) => p.system_role === "coach").map((p) => p.id)
  );
  // An accepted plan that's still in progress (not finished/abandoned) blocks
  // adding a new one. A terminal plan frees the coach to add the next.
  const hasActivePlan = messages.some((m) => m.plan_accepted && !m.plan_outcome && !m.plan_deactivated);
  // A live plan = the current (non-superseded, non-terminal) one, pending or
  // accepted. Only an admin can archive a conversation while one exists; coaches
  // and partners must finish/abandon the plan first.
  const hasLivePlan = messages.some(
    (m) => m.plan_id != null && !m.plan_deactivated && m.plan_outcome == null
  );
  // Submission flow: a partner (non-coach, non-admin) can mark a message while an
  // activity is active and nothing's pending review; a pending review freezes the
  // partner's composer and surfaces a Review button to coaches.
  const iAmPartner = !iAmCoach && !isAdmin;
  const canSubmit = !!activeActivity && !activeActivity.pendingReview && iAmPartner;
  const partnerFrozen = !!activeActivity?.pendingReview && iAmPartner;
  const coachCanReview = !!activeActivity?.pendingReview && (iAmCoach || isAdmin);

  const toggleArchive = async () => {
    if (
      !archived &&
      !(await dialog.confirm(
        isAdmin
          ? "Archive this conversation for ALL participants?"
          : "Archive this conversation?",
        { title: "Archive", confirmText: "Archive" }
      ))
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

  const renameThread = async () => {
    const current = thread?.subject ?? "";
    const next = await dialog.prompt("Rename this partnership", {
      title: "Rename",
      defaultValue: current,
      placeholder: "Partnership name",
      confirmText: "Save",
    });
    if (next == null || !next.trim() || next.trim() === current) return;
    try {
      const res = await fetch(pathWithBase(`/api/messages/threads/${threadId}/rename`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subject: next.trim() }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error((d as { error?: string }).error || "Couldn't rename");
      }
      fetchThread(false);
      onPosted();
    } catch (e) {
      dialog.alert(e instanceof Error ? e.message : "Couldn't rename the conversation.");
    }
  };

  const decideSubmission = async (decision: "approve" | "reject") => {
    const verb = decision === "approve" ? "Approve" : "Reject";
    const note = await dialog.prompt(`${verb} this plan submission?`, {
      title: `${verb} plan`,
      placeholder: "Optional note to the coach…",
      multiline: true,
      confirmText: verb,
    });
    if (note == null) return; // cancelled
    try {
      const res = await fetch(
        pathWithBase(`/api/admin/templates/submissions/${threadId}/decision`),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision, message: note }),
        }
      );
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error((d as { error?: string }).error || "Couldn't submit decision");
      }
      fetchThread(false);
      onPosted();
    } catch (e) {
      dialog.alert(e instanceof Error ? e.message : "Couldn't submit the decision.");
    }
  };

  const fetchThread = useCallback(
    async (showSpinner: boolean) => {
      if (showSpinner) setLoading(true);
      try {
        const d = await apiFetch<{
          thread: ThreadSummary;
          messages: MessageView[];
          activeActivity: ActiveActivity | null;
          lastReadAt: string | null;
        }>(`/api/messages/threads/${threadId}`);
        setThread(d.thread);
        setMessages(d.messages);
        setActiveActivity(d.activeActivity ?? null);
        // Capture the read boundary only on the initial open (polls would see it
        // already marked read and erase the unread marker).
        if (showSpinner) setLastReadAt(d.lastReadAt ?? null);
      } catch {
        if (showSpinner) {
          setThread(null);
          setMessages([]);
          setActiveActivity(null);
        }
      } finally {
        if (showSpinner) setLoading(false);
      }
    },
    [threadId]
  );

  useEffect(() => {
    stick.current = true; // jump to bottom when switching threads
    didInitialScroll.current = false;
    setLastReadAt(null);
    fetchThread(true);
  }, [fetchThread]);

  // Poll for new messages in the open thread (silent — no spinner).
  useEffect(() => {
    const t = setInterval(() => fetchThread(false), 2500);
    return () => clearInterval(t);
  }, [fetchThread]);

  // The first message the user hasn't read yet (from someone else, after their
  // last-read time). Drives the "New" divider and the initial scroll position.
  const firstUnreadId = useMemo(() => {
    if (!lastReadAt) return null;
    const cutoff = new Date(lastReadAt).getTime();
    const m = messages.find(
      (x) => x.sender_id !== meId && new Date(x.created_at).getTime() > cutoff
    );
    return m?.id ?? null;
  }, [messages, lastReadAt, meId]);

  // On first open, land on the first unread message; otherwise (and on new
  // messages while pinned to the bottom) keep the newest in view.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!didInitialScroll.current && !loading && messages.length > 0) {
      didInitialScroll.current = true;
      if (firstUnreadId != null) {
        const node = el.querySelector<HTMLElement>(`[data-mid="${firstUnreadId}"]`);
        if (node) {
          node.scrollIntoView({ block: "start" });
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          return;
        }
      }
      el.scrollTop = el.scrollHeight;
      return;
    }
    if (stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, deweyThinking, loading, firstUnreadId]);

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

  // A partner marks one of their messages as the active activity's submission.
  const submitMessage = useCallback(
    async (messageId: number) => {
      if (!activeActivity) return;
      const openAttest = activeActivity.gating === "OPEN" && !activeActivity.isLastInPhase;
      const ok = await dialog.confirm(
        openAttest
          ? `Submit this message as your work for "${activeActivity.nodeLabel}" and mark the activity complete? The plan will move to the next activity.`
          : `Submit this message for "${activeActivity.nodeLabel}"? Your coach will review it before the plan advances, and the chat will pause until they do.`,
        { title: "Submit", confirmText: "Submit" }
      );
      if (!ok) return;
      try {
        const res = await fetch(
          pathWithBase(`/api/messages/threads/${threadId}/activity/submit`),
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ messageId }),
          }
        );
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          throw new Error((d as { error?: string }).error || "Couldn't submit");
        }
        fetchThread(false);
        onPosted();
      } catch (e) {
        dialog.alert(e instanceof Error ? e.message : "Couldn't submit that message.");
      }
    },
    [activeActivity, dialog, threadId, fetchThread, onPosted]
  );

  // A partner withdraws their own pending submission before the coach reviews it.
  const withdrawSubmission = useCallback(async () => {
    if (
      !(await dialog.confirm(
        "Withdraw your submission? Your coach hasn't reviewed it yet, and the chat will reopen so you can keep working.",
        { title: "Withdraw submission", confirmText: "Withdraw" }
      ))
    )
      return;
    try {
      const res = await fetch(
        pathWithBase(`/api/messages/threads/${threadId}/activity/withdraw`),
        { method: "POST" }
      );
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error((d as { error?: string }).error || "Couldn't withdraw");
      }
      fetchThread(false);
      onPosted();
    } catch (e) {
      dialog.alert(e instanceof Error ? e.message : "Couldn't withdraw the submission.");
    }
  }, [dialog, threadId, fetchThread, onPosted]);

  const acceptPlan = useCallback(
    async (messageId: number) => {
      if (
        !(await dialog.confirm(
          "Accept this plan? Once every participant has accepted, it locks in as the active plan — it can't be edited or replaced without unlocking, which restarts it from the beginning.",
          { title: "Accept plan", confirmText: "Accept" }
        ))
      )
        return;
      try {
        const res = await fetch(pathWithBase(`/api/messages/threads/${threadId}/accept-plan`), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messageId }),
        });
        if (!res.ok) throw new Error();
        fetchThread(false);
      } catch {
        dialog.alert("Couldn't accept the plan.");
      }
    },
    [dialog, threadId, fetchThread]
  );

  const unlockPlan = useCallback(
    async (messageId: number) => {
      if (
        !(await dialog.confirm(
          "Unlock this plan? You'll be able to edit or replace it again, but accepting restarts the plan from the beginning.",
          { title: "Unlock plan", confirmText: "Unlock" }
        ))
      )
        return;
      try {
        const res = await fetch(pathWithBase(`/api/messages/threads/${threadId}/unlock-plan`), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messageId }),
        });
        if (!res.ok) throw new Error();
        fetchThread(false);
      } catch {
        dialog.alert("Couldn't unlock the plan.");
      }
    },
    [dialog, threadId, fetchThread]
  );

  const editPlan = useCallback(
    async (planId: number) => {
      if (
        !(await dialog.confirm("Edit this plan? Your changes update the partnership's copy.", {
          title: "Edit plan",
          confirmText: "Edit",
        }))
      )
        return;
      setEditPlanId(planId);
    },
    [dialog]
  );

  const copyPlan = useCallback(
    async (planId: number) => {
      if (
        !(await dialog.confirm("Copy this plan into your personal plan library?", {
          title: "Copy plan",
          confirmText: "Copy",
        }))
      )
        return;
      try {
        await apiFetch(`/api/coach/templates/${planId}/duplicate`, { method: "POST" });
        await dialog.alert("Copied to your plans — find it under the Coaching Canvas.", {
          title: "Copied",
        });
      } catch (e) {
        dialog.alert(e instanceof Error ? e.message : "Couldn't copy the plan");
      }
    },
    [dialog]
  );

  const setPlanOutcome = useCallback(
    async (messageId: number, outcome: "finished" | "abandoned" | "active") => {
      const prompts: Record<typeof outcome, string> = {
        finished: "Mark this plan finished?",
        abandoned: "Mark this plan abandoned?",
        active: "Reopen this plan (back to in progress)?",
      };
      if (!(await dialog.confirm(prompts[outcome], { title: "Plan status" }))) return;
      try {
        const res = await fetch(pathWithBase(`/api/messages/threads/${threadId}/plan-outcome`), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messageId, outcome }),
        });
        if (!res.ok) throw new Error();
        fetchThread(false);
      } catch {
        dialog.alert("Couldn't update the plan.");
      }
    },
    [dialog, threadId, fetchThread]
  );

  const revivePlan = useCallback(
    async (messageId: number) => {
      if (
        !(await dialog.confirm(
          "Revive this plan? It will replace the current active plan and drop back in as the latest — everyone re-accepts it.",
          { title: "Revive plan", confirmText: "Revive" }
        ))
      )
        return;
      try {
        const res = await fetch(pathWithBase(`/api/messages/threads/${threadId}/revive-plan`), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messageId }),
        });
        if (!res.ok) throw new Error();
        fetchThread(false);
      } catch {
        dialog.alert("Couldn't revive the plan.");
      }
    },
    [dialog, threadId, fetchThread]
  );

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
      <div className="shrink-0 border-b border-dewey-border bg-dewey-surface px-4 py-2">
        <div className="flex items-center gap-2">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              aria-label="Back to conversations"
              title="Back to conversations"
              className="-ml-1 shrink-0 rounded p-1 text-dewey-mute hover:bg-dewey-surface-2 hover:text-dewey-ink md:hidden"
            >
              ‹ Back
            </button>
          )}
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
          {acceptedPlan && (
            <>
              <button
                type="button"
                className="flex shrink-0 items-center gap-1 rounded-full border border-dewey-accent/40 bg-dewey-accent/5 px-2 py-0.5 text-xs text-dewey-accent hover:bg-dewey-accent/10"
                onClick={() => {
                  setViewPlanFocus(false);
                  setViewPlanId(acceptedPlan.plan_id as number);
                }}
                title={acceptedPlan.plan_name ?? "Plan"}
              >
                🗂️ <span className="max-w-[140px] truncate">View plan</span>
              </button>
              {hasActivePlan && (
                <button
                  type="button"
                  className="flex shrink-0 items-center gap-1 rounded-full border border-dewey-accent/40 bg-dewey-accent/5 px-2 py-0.5 text-xs text-dewey-accent hover:bg-dewey-accent/10"
                  onClick={() => {
                    setViewPlanFocus(true);
                    setViewPlanId(acceptedPlan.plan_id as number);
                  }}
                  title="Open the current activity"
                >
                  🎯 <span className="max-w-[140px] truncate">Current activity</span>
                </button>
              )}
            </>
          )}
          <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-1.5">
            {coachCanReview && (
              <button
                type="button"
                onClick={() => setReviewing(true)}
                className="flex shrink-0 items-center gap-1 rounded-full bg-dewey-accent px-2.5 py-0.5 text-xs font-semibold text-white shadow-sm hover:opacity-90"
                title="Review the partner's submission"
              >
                🔎 <span className="max-w-[160px] truncate">Review submission</span>
              </button>
            )}
            {isAdmin && submissionPending && (
              <>
                <PlanPill icon="✅" label="Approve" onClick={() => decideSubmission("approve")} />
                <PlanPill icon="🚫" label="Reject" onClick={() => decideSubmission("reject")} />
              </>
            )}
            {canManage && <PlanPill icon="📝" label="Rename" onClick={renameThread} />}
            {iAmCoach && !hasActivePlan && (
              <PlanPill icon="➕" label="Add plan" onClick={() => setPicking(true)} />
            )}
            {(isAdmin || !hasLivePlan || archived) && (
              <PlanPill
                icon="🗄️"
                label={archived ? "Unarchive" : "Archive"}
                onClick={toggleArchive}
              />
            )}
          </div>
        </div>
        {thread && thread.participants.length > 0 && (
          <p className="mt-1 truncate text-xs text-dewey-mute">
            {thread.participants.map((p, i) => {
              const isCoach = p.system_role === "coach";
              return (
                <span key={p.id} title={isCoach ? "Coach" : undefined}>
                  {i > 0 && ", "}
                  <span className={isCoach ? "font-medium text-dewey-ink" : ""}>
                    {isCoach && <span aria-hidden>⚡️ </span>}
                    {p.nickname || p.full_name}
                  </span>
                </span>
              );
            })}
          </p>
        )}
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto px-4 py-3">
        {/* min-h-full + justify-end anchors a short conversation to the bottom so
            the pane reads as filled, while long threads scroll normally. */}
        <div className="flex min-h-full flex-col justify-end gap-3">
          {loading ? (
            <p className="text-xs text-dewey-mute">Loading…</p>
          ) : messages.length === 0 ? (
            <p className="text-xs text-dewey-mute">No messages yet.</p>
          ) : (
            messages.map((m) => (
              <div key={m.id} data-mid={m.id} className="scroll-mt-2">
                {m.id === firstUnreadId && (
                  <div className="my-1 flex items-center gap-2" aria-label="New messages">
                    <span className="h-px flex-1 bg-dewey-accent/40" />
                    <span className="rounded-full bg-dewey-accent/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-dewey-accent">
                      New
                    </span>
                    <span className="h-px flex-1 bg-dewey-accent/40" />
                  </div>
                )}
                <MessageBubble
                  message={m}
                  mine={m.sender_id === meId}
                  meId={meId}
                  iAmCoach={iAmCoach}
                  senderIsCoach={m.sender_id != null && coachIds.has(m.sender_id)}
                  canSubmit={canSubmit && m.sender_id === meId && m.plan_id == null && !m.is_ai}
                  isCurrentSubmission={activeActivity?.submission?.messageId === m.id}
                  onSubmit={submitMessage}
                  onPreview={onPreview}
                  onViewPlan={(planId) => {
                    setViewPlanFocus(false);
                    setViewPlanId(planId);
                  }}
                  onAcceptPlan={acceptPlan}
                  onUnlockPlan={unlockPlan}
                  onSetOutcome={setPlanOutcome}
                  onEditPlan={editPlan}
                  onCopyPlan={copyPlan}
                  onDismissPlan={dismissPlan}
                  onRevivePlan={revivePlan}
                  onReply={(t) => setReplyTarget(t)}
                />
              </div>
            ))
          )}
          {deweyThinking && (
            <div className="flex justify-start">
              <div className="max-w-[min(85%,760px)]">
                <div className="mb-0.5 flex items-center gap-2 text-[11px] text-dewey-mute">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white ring-1 ring-dewey-border">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={pathWithBase("/logo.png")} alt="@dewey" className="h-5 w-5 object-contain" />
                  </span>
                  <span className="font-medium text-dewey-ink">Dewey</span>
                </div>
                <div className="inline-flex h-7 w-fit items-center justify-center rounded-full border border-dewey-border bg-dewey-accent/10 px-3">
                  <span className="typing-dots" aria-label="Dewey is typing">
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
      </div>

      {thread?.kind === "compliance" ? (
        <div className="shrink-0 border-t border-dewey-border bg-dewey-surface px-4 py-3 text-center text-xs text-dewey-mute">
          System notice — replies are disabled.
        </div>
      ) : partnerFrozen ? (
        <div className="flex shrink-0 flex-col items-center gap-1.5 border-t border-dewey-border bg-dewey-surface px-4 py-3 text-center text-xs text-dewey-mute">
          <span>
            ⏳ Your submission for{" "}
            <span className="font-medium text-dewey-ink">{activeActivity?.nodeLabel}</span> is awaiting
            your coach&apos;s review. The chat will reopen once they respond.
          </span>
          <button
            type="button"
            onClick={withdrawSubmission}
            className="inline-flex items-center gap-1 rounded-full border border-dewey-accent/40 bg-dewey-accent/5 px-2 py-0.5 text-[11px] text-dewey-accent hover:bg-dewey-accent/10"
          >
            ↩ Withdraw submission
          </button>
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

      {reviewing && activeActivity && (
        <ReviewModal
          threadId={threadId}
          activity={activeActivity}
          onClose={() => setReviewing(false)}
          onDecided={() => {
            setReviewing(false);
            fetchThread(false);
            onPosted();
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
      {viewPlanId != null && (
        <TemplateReadOnly
          templateId={viewPlanId}
          templatesBase="/api/partnership-plans"
          focusCurrentActivity={viewPlanFocus}
          onClose={() => setViewPlanId(null)}
        />
      )}
      {editPlanId != null && (
        <TemplateCanvas
          templateId={editPlanId}
          templatesBase="/api/coach/templates"
          onClose={() => {
            setEditPlanId(null);
            fetchThread(false);
          }}
        />
      )}
    </>
  );
}

/** Accent pill action used on plan bubbles — matches the thread-card/header pill. */
function PlanPill({
  icon,
  label,
  onClick,
}: {
  icon: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded-full border border-dewey-accent/40 bg-dewey-accent/5 px-2 py-0.5 text-xs text-dewey-accent hover:bg-dewey-accent/10"
    >
      <span aria-hidden>{icon}</span> {label}
    </button>
  );
}

function MessageBubble({
  message: m,
  mine,
  meId,
  iAmCoach,
  senderIsCoach,
  canSubmit,
  isCurrentSubmission,
  onSubmit,
  onPreview,
  onViewPlan,
  onAcceptPlan,
  onUnlockPlan,
  onSetOutcome,
  onEditPlan,
  onCopyPlan,
  onDismissPlan,
  onRevivePlan,
  onReply,
}: {
  message: MessageView;
  mine: boolean;
  meId: number | null;
  iAmCoach: boolean;
  senderIsCoach: boolean;
  canSubmit: boolean;
  isCurrentSubmission: boolean;
  onSubmit: (messageId: number) => void;
  onPreview: (a: AttachmentMeta) => void;
  onViewPlan: (planId: number) => void;
  onAcceptPlan: (messageId: number) => void;
  onUnlockPlan: (messageId: number) => void;
  onSetOutcome: (messageId: number, outcome: "finished" | "abandoned" | "active") => void;
  onEditPlan: (planId: number) => void;
  onCopyPlan: (planId: number) => void;
  onDismissPlan: (messageId: number) => void;
  onRevivePlan: (messageId: number) => void;
  onReply: (t: ReplyTarget) => void;
}) {
  const senderLabel = m.is_ai ? "Dewey" : m.sender_name ?? "Unknown";
  // Per-plan acceptance state (multi-party): any coach in the thread manages the
  // plan; any participant accepts; it locks once everyone has.
  const canManagePlan = iAmCoach;
  const iAccepted = meId != null && m.plan_accepted_by.includes(meId);
  const acceptedCount = m.plan_accepted_by.length;
  // Any non-active plan (superseded by a newer one, or finished/abandoned) is
  // grayed out and offers a Revive button. Only the active plan is highlighted.
  const planInactive = m.plan_deactivated || m.plan_outcome != null;
  // Quoted reply: collapsed (one line) by default, click to expand.
  const [replyExpanded, setReplyExpanded] = useState(false);
  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div className={`flex max-w-[min(85%,760px)] flex-col ${mine ? "items-end" : "items-start"}`}>
        <div className="mb-0.5 flex items-center gap-2 text-[11px] text-dewey-mute">
          {m.is_ai ? (
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white ring-1 ring-dewey-border">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={pathWithBase("/logo.png")} alt="@dewey" className="h-5 w-5 object-contain" />
            </span>
          ) : (
            <div className={`inline-flex shrink-0 rounded-full ${senderIsCoach ? "ring-1 ring-dewey-accent" : ""}`}>
              <Avatar userId={m.sender_id} name={m.sender_name} size={36} />
            </div>
          )}
          <span className="font-medium text-dewey-ink">{senderLabel}</span>
          <span>{new Date(m.created_at).toLocaleString()}</span>
        </div>
        {/* Quoted reply target (iMessage-style): hover for the full text, click to
            expand/collapse. */}
        {m.reply_to != null && m.reply_excerpt != null && (
          <button
            type="button"
            onClick={() => setReplyExpanded((v) => !v)}
            title={`${m.reply_sender}: ${m.reply_excerpt}`}
            className={`mb-1 max-w-full rounded-md border-l-2 border-dewey-accent/50 bg-dewey-surface-2 px-2 py-1 text-left text-[11px] text-dewey-mute hover:bg-dewey-surface ${
              replyExpanded ? "whitespace-pre-wrap" : "truncate"
            }`}
          >
            <span className="font-medium text-dewey-ink">↩ {m.reply_sender}: </span>
            {m.reply_excerpt}
          </button>
        )}
        {(m.submission_status || m.restricted) && (
          <div className={`mb-1 flex flex-wrap items-center gap-1 ${mine ? "justify-end" : ""}`}>
            {m.submission_status && (
              <span
                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                  m.submission_status === "approved"
                    ? "bg-green-100 text-green-800"
                    : m.submission_status === "returned"
                    ? "bg-dewey-surface-2 text-dewey-mute"
                    : "bg-amber-100 text-amber-800"
                }`}
              >
                📎{" "}
                {m.submission_status === "approved"
                  ? "Submission · approved"
                  : m.submission_status === "returned"
                  ? "Submission · returned"
                  : "Submission · pending review"}
              </span>
            )}
            {m.restricted && (
              <span className="inline-flex items-center gap-1 rounded-full bg-dewey-surface-2 px-2 py-0.5 text-[11px] text-dewey-mute">
                🔒 Coaches &amp; partner
              </span>
            )}
          </div>
        )}
        {m.plan_id != null ? (
          // Specialized plan bubble. "View plan" opens the plan preview directly.
          <div
            className={`rounded-lg border p-3 ${
              planInactive
                ? "border-dewey-border bg-dewey-surface-2 opacity-75"
                : "border-dewey-accent/40 bg-dewey-accent/5"
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="text-lg">🗂️</span>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-dewey-mute">
                  Coaching plan
                  {m.plan_deactivated ? (
                    <span className="rounded bg-dewey-surface px-1.5 py-0.5 text-[9px] font-medium text-dewey-mute">
                      Superseded
                    </span>
                  ) : m.plan_outcome === "finished" ? (
                    <span className="rounded bg-green-100 px-1.5 py-0.5 text-[9px] font-medium text-green-800">
                      Finished
                    </span>
                  ) : m.plan_outcome === "abandoned" ? (
                    <span className="rounded bg-dewey-surface-2 px-1.5 py-0.5 text-[9px] font-medium text-dewey-mute">
                      Abandoned
                    </span>
                  ) : m.plan_accepted ? (
                    <span className="rounded bg-green-100 px-1.5 py-0.5 text-[9px] font-medium text-green-800">
                      Active and Locked
                    </span>
                  ) : (
                    acceptedCount > 0 && (
                      <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[9px] font-medium text-amber-800">
                        {acceptedCount}/{m.plan_participant_count} accepted
                      </span>
                    )
                  )}
                </div>
                <button
                  type="button"
                  className="truncate text-left text-sm font-semibold text-dewey-ink hover:underline"
                  onClick={() => onViewPlan(m.plan_id as number)}
                >
                  {m.plan_name ?? "Plan"}
                </button>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <PlanPill icon="🗂️" label="View plan" onClick={() => onViewPlan(m.plan_id as number)} />
              {/* Inactive (superseded, finished, or abandoned): owner can revive it
                  (re-posts as the active plan) or clear it away. */}
              {planInactive ? (
                canManagePlan && (
                  <>
                    <PlanPill icon="♻️" label="Revive" onClick={() => onRevivePlan(m.id)} />
                    <PlanPill icon="📋" label="Copy to my plans" onClick={() => onCopyPlan(m.plan_id as number)} />
                  </>
                )
              ) : m.plan_accepted ? (
                // Active + locked. Owner: unlock to edit, complete, or abandon.
                canManagePlan && (
                  <>
                    <PlanPill icon="🔓" label="Unlock" onClick={() => onUnlockPlan(m.id)} />
                    <PlanPill icon="🏁" label="Complete" onClick={() => onSetOutcome(m.id, "finished")} />
                    <PlanPill icon="🚫" label="Abandon" onClick={() => onSetOutcome(m.id, "abandoned")} />
                  </>
                )
              ) : (
                // Proposed / awaiting: every participant accepts; owner manages it.
                <>
                  {iAccepted ? (
                    <span className="px-1 text-xs text-green-700">✓ You accepted</span>
                  ) : (
                    <PlanPill icon="✅" label="Accept" onClick={() => onAcceptPlan(m.id)} />
                  )}
                  {canManagePlan && (
                    <>
                      <PlanPill icon="✏️" label="Edit" onClick={() => onEditPlan(m.plan_id as number)} />
                      <PlanPill icon="📋" label="Copy to my plans" onClick={() => onCopyPlan(m.plan_id as number)} />
                      <PlanPill icon="🗑️" label="Dismiss" onClick={() => onDismissPlan(m.id)} />
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        ) : (
          <div
            className={`rounded-lg px-3 py-2 text-sm ${
              mine ? "bg-dewey-accent/15 text-dewey-ink" : "bg-dewey-surface text-dewey-ink"
            } border border-dewey-border`}
          >
            {m.body &&
              (m.is_ai ? (
                <div className="chat-md text-sm">
                  <ReactMarkdown>{normalizeDeweyMention(m.body)}</ReactMarkdown>
                </div>
              ) : (
                <p className="whitespace-pre-wrap">{normalizeDeweyMention(m.body)}</p>
              ))}
            {m.attachments.length > 0 && (
              <div className="mt-2 space-y-2">
                {m.attachments.map((a) => (
                  <Attachment key={a.id} att={a} onPreview={onPreview} />
                ))}
              </div>
            )}
            {m.sources.length > 0 && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5 border-t border-dewey-border pt-1.5">
                <span className="text-[11px] text-dewey-mute">Sources</span>
                {m.sources.map((s, j) => (
                  <a
                    key={j}
                    href={pathWithBase(`/api/rag/source?path=${encodeURIComponent(s.path)}`)}
                    target="_blank"
                    rel="noreferrer"
                    title={s.name}
                    className="inline-block max-w-[180px] truncate rounded-full border border-dewey-border bg-dewey-surface-2 px-2 py-0.5 text-[11px] text-dewey-mute hover:border-dewey-mute hover:text-dewey-ink"
                  >
                    {s.name}
                  </a>
                ))}
              </div>
            )}
          </div>
        )}
        {/* Reply pill beneath messages from others (incl. Dewey), against the
            right edge of the bubble. */}
        {!mine && (
          <div className="mt-0.5 flex w-full justify-end">
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-full border border-dewey-border bg-dewey-surface px-2 py-0.5 text-[11px] text-dewey-mute hover:border-dewey-mute hover:text-dewey-ink"
              onClick={() =>
                onReply({
                  id: m.id,
                  sender: senderLabel,
                  excerpt: (m.body || (m.plan_id ? `Plan: ${m.plan_name ?? ""}` : "")).slice(0, 120),
                  isAi: m.is_ai,
                })
              }
            >
              <span aria-hidden>↩</span> {m.is_ai ? "Reply to Dewey" : "Reply"}
            </button>
          </div>
        )}
        {/* Partner: mark this (own) message as the active activity's submission. */}
        {canSubmit && !isCurrentSubmission && (
          <div className="mt-0.5 flex w-full justify-end">
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-full border border-dewey-accent/40 bg-dewey-accent/5 px-2 py-0.5 text-[11px] text-dewey-accent hover:bg-dewey-accent/10"
              onClick={() => onSubmit(m.id)}
            >
              <span aria-hidden>📎</span> Mark as Submission
            </button>
          </div>
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
  const isDoc = att.mime_type === "text/html";

  if (isDoc) {
    return (
      <button
        type="button"
        onClick={() => onPreview(att)}
        className="flex items-center gap-2 rounded border border-dewey-border bg-dewey-surface-2 px-2 py-1 text-xs text-dewey-accent hover:underline"
      >
        📝 {att.filename.replace(/\.html$/i, "")}
      </button>
    );
  }
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
  const [writing, setWriting] = useState(false);
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
    // Snapshot the outgoing content, then clear the composer immediately so the
    // message doesn't linger in the box while a (slow, synchronous @dewey) send
    // is in flight. Restore it if the send fails.
    const sentBody = body;
    const sentFiles = files;
    const sentReply = replyTarget;
    setBody("");
    setFiles([]);
    onClearReply(); // drop the reply strip immediately, like the text box
    setSending(true);
    if (willDewey) onDeweyPending(true);
    try {
      const form = new FormData();
      form.append("body", sentBody);
      if (sentReply) form.append("replyTo", String(sentReply.id));
      sentFiles.forEach((f) => form.append("files", f));
      const res = await fetch(pathWithBase(`/api/messages/threads/${threadId}/messages`), {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error((d as { error?: string }).error || `HTTP ${res.status}`);
      }
      onSent();
    } catch (e) {
      // Put the unsent content back so the user doesn't lose it.
      setBody((cur) => (cur ? cur : sentBody));
      setFiles((cur) => (cur.length ? cur : sentFiles));
      dialog.alert(e instanceof Error ? e.message : "Failed to send");
    } finally {
      setSending(false);
      if (willDewey) onDeweyPending(false);
    }
  };

  return (
    <div className="relative shrink-0 border-t border-dewey-border bg-dewey-surface px-3 py-2">
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
          title="Upload a file"
        >
          📎
        </button>
        <button
          type="button"
          className="dewey-btn-secondary shrink-0"
          onClick={() => setWriting(true)}
          title="Write a document"
        >
          📝
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
      {writing && (
        <DocumentEditorModal
          onClose={() => setWriting(false)}
          onAttach={(filename, html) => {
            setWriting(false);
            const safe = sanitizeDocumentHtml(html);
            const file = new File([safe], `${filename}.html`, { type: "text/html" });
            setFiles((prev) => [...prev, file]);
          }}
        />
      )}
    </div>
  );
}

/**
 * Lightweight WYSIWYG document editor (no dependency): a title, a toolbar
 * (bold / italic / underline / font size / lists / indent, with active-state
 * highlighting) and a contentEditable body. Yields sanitized HTML the composer
 * attaches as a file.
 */
function DocumentEditorModal({
  onClose,
  onAttach,
}: {
  onClose: () => void;
  onAttach: (filename: string, html: string) => void;
}) {
  const dialog = useDialog();
  const [title, setTitle] = useState("Document");
  const bodyRef = useRef<HTMLDivElement>(null);
  // Which inline/list commands are active for the current selection (for toolbar
  // highlighting). Updated on every selection change while the editor has focus.
  const [active, setActive] = useState<Record<string, boolean>>({});

  const refreshActive = useCallback(() => {
    if (typeof document === "undefined") return;
    const q = (c: string) => {
      try {
        return document.queryCommandState(c);
      } catch {
        return false;
      }
    };
    setActive({
      bold: q("bold"),
      italic: q("italic"),
      underline: q("underline"),
      insertOrderedList: q("insertOrderedList"),
      insertUnorderedList: q("insertUnorderedList"),
    });
  }, []);

  useEffect(() => {
    document.addEventListener("selectionchange", refreshActive);
    return () => document.removeEventListener("selectionchange", refreshActive);
  }, [refreshActive]);

  const cmd = (command: string, value?: string) => {
    bodyRef.current?.focus();
    // Prefer CSS styles over deprecated presentational tags where supported.
    try {
      document.execCommand("styleWithCSS", false, "true");
    } catch {
      /* falls back to <font>/<b>, both handled by the sanitizer */
    }
    document.execCommand(command, false, value);
    refreshActive();
  };

  const attach = () => {
    const html = bodyRef.current?.innerHTML ?? "";
    if (!html.replace(/<[^>]*>/g, "").trim()) {
      dialog.alert("Write something in the document first.");
      return;
    }
    onAttach(title.trim() || "Document", html);
  };

  // Toolbar button: onMouseDown + preventDefault keeps the selection in the
  // editable while the command runs (a plain click would blur it first).
  const ToolBtn = ({
    cmdName,
    value,
    label,
    title: t,
    extra,
  }: {
    cmdName: string;
    value?: string;
    label: string;
    title: string;
    extra?: string;
  }) => (
    <button
      type="button"
      title={t}
      onMouseDown={(e) => {
        e.preventDefault();
        cmd(cmdName, value);
      }}
      className={`rounded px-2 py-1 text-sm hover:bg-dewey-surface-2 ${extra ?? ""} ${
        active[cmdName] ? "bg-dewey-accent/15 text-dewey-accent" : ""
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-dewey-border bg-dewey-cream shadow-xl">
        <div className="flex items-center justify-between gap-2 border-b border-dewey-border px-4 py-2">
          <input
            className="dewey-input flex-1"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Document title"
          />
          <button
            type="button"
            className="shrink-0 text-dewey-mute hover:text-dewey-ink"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-1 border-b border-dewey-border px-3 py-1.5">
          <ToolBtn cmdName="bold" label="B" title="Bold" extra="font-bold" />
          <ToolBtn cmdName="italic" label="I" title="Italic" extra="italic" />
          <ToolBtn cmdName="underline" label="U" title="Underline" extra="underline" />
          <span className="mx-1 text-dewey-border">|</span>
          <select
            className="dewey-input h-8 w-auto py-0 text-sm"
            defaultValue="3"
            onChange={(e) => cmd("fontSize", e.target.value)}
            title="Font size"
          >
            <option value="1">Small</option>
            <option value="3">Normal</option>
            <option value="5">Large</option>
            <option value="7">Huge</option>
          </select>
          <span className="mx-1 text-dewey-border">|</span>
          <ToolBtn cmdName="insertUnorderedList" label="• List" title="Bulleted list" />
          <ToolBtn cmdName="insertOrderedList" label="1. List" title="Numbered list" />
          <ToolBtn cmdName="outdent" label="⇤" title="Decrease indent" />
          <ToolBtn cmdName="indent" label="⇥" title="Increase indent" />
        </div>
        <div
          ref={bodyRef}
          contentEditable
          suppressContentEditableWarning
          onKeyUp={refreshActive}
          onMouseUp={refreshActive}
          className="chat-md min-h-[240px] flex-1 overflow-y-auto bg-white px-4 py-3 text-sm text-black focus:outline-none [&_ol]:list-decimal [&_ol]:pl-6 [&_ul]:list-disc [&_ul]:pl-6"
        />
        <div className="flex justify-end gap-2 border-t border-dewey-border px-4 py-3">
          <button type="button" className="dewey-btn-secondary w-auto" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="dewey-btn-primary w-auto" onClick={attach}>
            Attach document
          </button>
        </div>
      </div>
    </div>
  );
}

type SubmissionView = {
  nodeLabel: string;
  instructions: string;
  artifact: string;
  partnerName: string | null;
  body: string;
  attachments: AttachmentMeta[];
};
type ConsultTurn = {
  id: number;
  role: "coach" | "dewey";
  body: string;
  created_at: string;
  sources: { name: string; path: string }[];
};
type ReviewData = {
  activity: {
    nodeLabel: string;
    instructions: string;
    artifact: string;
    gating: "OPEN" | "REVIEWED";
    phaseName: string | null;
    exitConditions: string | null;
    isLastInPhase: boolean;
  };
  submissionId: number;
  submission: SubmissionView | null;
  prior: SubmissionView[];
  consults: ConsultTurn[];
};

/**
 * One earlier-phase submission, collapsed under its activity name. Expanding
 * reveals the activity's description + deliverable and what the partner submitted.
 */
function PriorSubmissionItem({
  sub,
  onPreview,
}: {
  sub: SubmissionView;
  onPreview: (a: AttachmentMeta) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-dewey-border bg-dewey-surface">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
      >
        <span className="truncate text-sm font-medium text-dewey-ink">{sub.nodeLabel}</span>
        <span className="shrink-0 text-xs text-dewey-mute">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-dewey-border px-3 py-2 text-sm">
          {sub.instructions && (
            <p className="whitespace-pre-wrap text-dewey-mute">
              <span className="font-medium text-dewey-ink">Activity:</span> {sub.instructions}
            </p>
          )}
          {sub.artifact && (
            <p className="text-dewey-mute">
              <span className="font-medium text-dewey-ink">Deliverable:</span> {sub.artifact}
            </p>
          )}
          <div className="rounded-md bg-dewey-surface-2 px-2 py-1.5">
            <p className="mb-0.5 text-[11px] font-medium text-dewey-mute">
              Submitted{sub.partnerName ? ` · ${sub.partnerName}` : ""}
            </p>
            {sub.body && <p className="whitespace-pre-wrap text-dewey-ink">{sub.body}</p>}
            {sub.attachments.length > 0 && (
              <div className="mt-2 space-y-2">
                {sub.attachments.map((a) => (
                  <Attachment key={a.id} att={a} onPreview={onPreview} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Coach review modal: shows the partner's submission, the activity goal, the
 * phase's earlier submissions (and exit conditions when it's the last activity),
 * and a persisted Dewey consult. The coach approves (advance) or returns with
 * feedback (visible only to coaches + the partner).
 */
function ReviewModal({
  threadId,
  activity,
  onClose,
  onDecided,
}: {
  threadId: number;
  activity: ActiveActivity;
  onClose: () => void;
  onDecided: () => void;
}) {
  const dialog = useDialog();
  const [data, setData] = useState<ReviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [returning, setReturning] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<AttachmentMeta | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await apiFetch<{ data: ReviewData | null }>(
        `/api/messages/threads/${threadId}/activity`
      );
      setData(d.data);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [threadId]);

  useEffect(() => {
    load();
  }, [load]);

  const ask = async () => {
    const q = question.trim();
    if (!q || asking) return;
    setAsking(true);
    setQuestion("");
    try {
      const res = await fetch(pathWithBase(`/api/messages/threads/${threadId}/activity/consult`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: q }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error((d as { error?: string }).error || "Dewey couldn't respond.");
      }
      await load();
    } catch (e) {
      setQuestion(q);
      dialog.alert(e instanceof Error ? e.message : "Dewey couldn't respond.");
    } finally {
      setAsking(false);
    }
  };

  const decide = async (decision: "approve" | "return") => {
    if (busy) return;
    if (decision === "return" && !feedback.trim()) {
      dialog.alert("Add feedback before returning the submission.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(pathWithBase(`/api/messages/threads/${threadId}/activity/review`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, feedback: decision === "return" ? feedback : undefined }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error((d as { error?: string }).error || "Couldn't submit the decision.");
      }
      onDecided();
    } catch (e) {
      dialog.alert(e instanceof Error ? e.message : "Couldn't submit the decision.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-dewey-border bg-dewey-cream shadow-xl">
        <div className="flex items-center justify-between border-b border-dewey-border px-4 py-2">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-dewey-ink">
              Review: {activity.nodeLabel}
            </h2>
            <p className="text-xs text-dewey-mute">
              {activity.gating === "OPEN" ? "Partner Attests" : "Coach Approves"}
              {activity.phaseName ? ` · ${activity.phaseName}` : ""}
              {activity.isLastInPhase ? " · last activity in phase" : ""}
            </p>
          </div>
          <button
            type="button"
            className="shrink-0 text-dewey-mute hover:text-dewey-ink"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3 text-sm">
          {loading ? (
            <p className="text-xs text-dewey-mute">Loading…</p>
          ) : !data ? (
            <p className="text-xs text-dewey-mute">Nothing to review.</p>
          ) : (
            <>
              <section>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-dewey-mute">
                  Activity goal
                </h3>
                {data.activity.instructions && (
                  <p className="whitespace-pre-wrap text-dewey-ink">{data.activity.instructions}</p>
                )}
                {data.activity.artifact && (
                  <p className="mt-1 text-dewey-mute">
                    <span className="font-medium">Expected output:</span> {data.activity.artifact}
                  </p>
                )}
                {data.activity.isLastInPhase && data.activity.exitConditions && (
                  <p className="mt-2 rounded-md border border-dewey-border bg-dewey-surface-2 px-2 py-1.5 text-xs text-dewey-ink">
                    <span className="font-medium">Phase exit conditions:</span>{" "}
                    {data.activity.exitConditions}
                  </p>
                )}
              </section>

              <section>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-dewey-mute">
                  Submission{data.submission?.partnerName ? ` · ${data.submission.partnerName}` : ""}
                </h3>
                {data.submission ? (
                  <div className="rounded-md border border-dewey-accent/40 bg-dewey-accent/5 px-3 py-2">
                    {data.submission.body && (
                      <p className="whitespace-pre-wrap text-dewey-ink">{data.submission.body}</p>
                    )}
                    {data.submission.attachments.length > 0 && (
                      <div className="mt-2 space-y-2">
                        {data.submission.attachments.map((a) => (
                          <Attachment key={a.id} att={a} onPreview={setPreview} />
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-dewey-mute">The submitted message is unavailable.</p>
                )}
              </section>

              {data.prior.length > 0 && (
                <section>
                  <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-dewey-mute">
                    Earlier submissions this phase
                  </h3>
                  <div className="space-y-2">
                    {data.prior.map((s, i) => (
                      <PriorSubmissionItem key={i} sub={s} onPreview={setPreview} />
                    ))}
                  </div>
                </section>
              )}

              <section>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-dewey-mute">
                  Consult Dewey
                </h3>
                <p className="mb-2 text-xs text-dewey-mute">
                  Ask Dewey whether this submission meets the activity&apos;s goal
                  {data.activity.isLastInPhase ? " (and the phase's exit conditions)" : ""}. Dewey
                  advises you — you make the call.
                </p>
                <div className="space-y-2">
                  {data.consults.map((c) => (
                    <div
                      key={c.id}
                      className={`rounded-md px-3 py-2 text-sm ${
                        c.role === "dewey"
                          ? "bg-dewey-surface text-dewey-ink"
                          : "bg-dewey-accent/15 text-dewey-ink"
                      } border border-dewey-border`}
                    >
                      <p className="mb-0.5 text-[11px] font-medium text-dewey-mute">
                        {c.role === "dewey" ? "Dewey" : "You"}
                      </p>
                      {c.role === "dewey" ? (
                        <div className="chat-md text-sm">
                          <ReactMarkdown>{c.body}</ReactMarkdown>
                        </div>
                      ) : (
                        <p className="whitespace-pre-wrap">{c.body}</p>
                      )}
                      {c.sources.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 border-t border-dewey-border pt-1.5">
                          <span className="text-[11px] text-dewey-mute">Sources</span>
                          {c.sources.map((s, j) => (
                            <a
                              key={j}
                              href={pathWithBase(`/api/rag/source?path=${encodeURIComponent(s.path)}`)}
                              target="_blank"
                              rel="noreferrer"
                              title={s.name}
                              className="inline-block max-w-[180px] truncate rounded-full border border-dewey-border bg-dewey-surface-2 px-2 py-0.5 text-[11px] text-dewey-mute hover:border-dewey-mute hover:text-dewey-ink"
                            >
                              {s.name}
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                  {asking && <p className="text-xs text-dewey-mute">Dewey is thinking…</p>}
                </div>
                <div className="mt-2 flex items-end gap-2">
                  <textarea
                    className="dewey-input min-h-[38px] flex-1 resize-none"
                    rows={1}
                    placeholder="Ask Dewey…"
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        ask();
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="dewey-btn-secondary w-auto shrink-0"
                    onClick={ask}
                    disabled={asking}
                  >
                    Ask
                  </button>
                </div>
              </section>
            </>
          )}
        </div>

        <div className="border-t border-dewey-border px-4 py-3">
          {returning ? (
            <div className="space-y-2">
              <textarea
                className="dewey-input min-h-[60px] w-full resize-none"
                placeholder="Feedback for the partner (only coaches and this partner will see it)…"
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  className="dewey-btn-secondary w-auto"
                  onClick={() => setReturning(false)}
                  disabled={busy}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="dewey-btn-primary w-auto"
                  onClick={() => decide("return")}
                  disabled={busy}
                >
                  {busy ? "Returning…" : "Return with feedback"}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="dewey-btn-secondary w-auto"
                onClick={() => setReturning(true)}
                disabled={busy}
              >
                ↩️ Return with feedback
              </button>
              <button
                type="button"
                className="dewey-btn-primary w-auto"
                onClick={() => decide("approve")}
                disabled={busy}
              >
                {busy ? "Approving…" : "✅ Approve & advance"}
              </button>
            </div>
          )}
        </div>
      </div>
      {preview && <AttachmentLightbox attachment={preview} onClose={() => setPreview(null)} />}
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
  const isDoc = attachment.mime_type === "text/html";
  const [docHtml, setDocHtml] = useState<string | null>(null);
  useEffect(() => {
    if (!isDoc) return;
    let cancelled = false;
    fetch(url)
      .then((r) => r.text())
      .then((t) => {
        if (!cancelled) setDocHtml(sanitizeDocumentHtml(t));
      })
      .catch(() => {
        if (!cancelled) setDocHtml("<p>Couldn't load this document.</p>");
      });
    return () => {
      cancelled = true;
    };
  }, [isDoc, url]);
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
        {isDoc ? (
          <div
            className="chat-md max-h-[85vh] overflow-y-auto rounded bg-white px-6 py-5 text-black [&_ol]:list-decimal [&_ol]:pl-6 [&_ul]:list-disc [&_ul]:pl-6"
            dangerouslySetInnerHTML={{ __html: docHtml ?? "Loading…" }}
          />
        ) : isPdf ? (
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
