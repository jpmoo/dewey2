"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { apiFetch } from "@/lib/api-client";
import { pathWithBase } from "@/lib/base-path";
import { useDialog } from "@/components/DialogProvider";
import { Avatar } from "@/components/Avatar";

type Participant = { id: number; full_name: string; system_role: string };
type AttachmentMeta = { id: number; filename: string; mime_type: string; size_bytes: number };
type MessageView = {
  id: number;
  sender_id: number | null;
  sender_name: string | null;
  body: string;
  created_at: string;
  attachments: AttachmentMeta[];
};
type ThreadSummary = {
  id: number;
  kind: string;
  subject: string | null;
  template_id: number | null;
  template_name: string | null;
  status: "open" | "approved" | "rejected" | null;
  created_at: string;
  updated_at: string;
  participants: Participant[];
  last_message: { body: string; created_at: string; sender_name: string | null } | null;
  message_count: number;
};

const STATUS_BADGE: Record<string, string> = {
  open: "bg-amber-100 text-amber-800",
  approved: "bg-green-100 text-green-800",
  rejected: "bg-red-100 text-red-700",
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
      ? `${r.district_name} · District-wide`
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
          <span className="truncate text-sm font-medium text-dewey-ink">
            {threadTitle(t, meId)}
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
          <div className="mt-0.5 truncate text-xs text-dewey-mute">{t.last_message.body}</div>
        )}
      </button>
    </li>
  );
}

function ThreadPane({
  threadId,
  meId,
  archived,
  onPreview,
  onPosted,
  onArchived,
}: {
  threadId: number;
  meId: number | null;
  archived: boolean;
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

  const toggleArchive = async () => {
    try {
      await fetch(pathWithBase(`/api/messages/threads/${threadId}/archive`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ archived: !archived }),
      });
      onArchived();
    } catch {
      dialog.alert("Couldn't update the conversation.");
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

  // Keep the newest message in view, unless the reader has scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

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
          <button
            type="button"
            className="ml-auto shrink-0 text-xs text-dewey-accent hover:underline"
            onClick={toggleArchive}
          >
            {archived ? "Unarchive" : "Archive"}
          </button>
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
                onPreview={onPreview}
              />
            ))
          )}
        </div>
      </div>

      {thread?.kind === "compliance" ? (
        <div className="border-t border-dewey-border bg-dewey-surface px-4 py-3 text-center text-xs text-dewey-mute">
          System notice — replies are disabled.
        </div>
      ) : (
        <Composer threadId={threadId} onSent={onSent} />
      )}
    </>
  );
}

function MessageBubble({
  message: m,
  mine,
  onPreview,
}: {
  message: MessageView;
  mine: boolean;
  onPreview: (a: AttachmentMeta) => void;
}) {
  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[min(75%,620px)] ${mine ? "items-end" : "items-start"}`}>
        <div className="mb-0.5 flex items-center gap-1.5 text-[11px] text-dewey-mute">
          <Avatar userId={m.sender_id} name={m.sender_name} size={18} />
          <span className="font-medium text-dewey-ink">{m.sender_name ?? "Unknown"}</span>
          <span>{new Date(m.created_at).toLocaleString()}</span>
        </div>
        <div
          className={`rounded-lg px-3 py-2 text-sm ${
            mine ? "bg-dewey-accent/15 text-dewey-ink" : "bg-dewey-surface text-dewey-ink"
          } border border-dewey-border`}
        >
          {m.body && <p className="whitespace-pre-wrap">{m.body}</p>}
          {m.attachments.length > 0 && (
            <div className="mt-2 space-y-2">
              {m.attachments.map((a) => (
                <Attachment key={a.id} att={a} onPreview={onPreview} />
              ))}
            </div>
          )}
        </div>
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

function Composer({ threadId, onSent }: { threadId: number; onSent: () => void }) {
  const dialog = useDialog();
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    setFiles((prev) => [...prev, ...Array.from(list)]);
    if (fileInput.current) fileInput.current.value = "";
  };

  const send = async () => {
    if (sending) return;
    if (!body.trim() && files.length === 0) return;
    setSending(true);
    try {
      const form = new FormData();
      form.append("body", body);
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
    }
  };

  return (
    <div className="border-t border-dewey-border bg-dewey-surface px-3 py-2">
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
          className="dewey-input min-h-[38px] flex-1 resize-none"
          rows={1}
          placeholder="Write a message…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
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

function AttachmentLightbox({
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
