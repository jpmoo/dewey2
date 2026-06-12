"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { apiFetch } from "@/lib/api-client";
import { pathWithBase } from "@/lib/base-path";

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

  const loadThreads = useCallback(async () => {
    try {
      const d = await apiFetch<{ threads: ThreadSummary[]; isAdmin: boolean }>(
        "/api/messages/threads"
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
  }, []);

  useEffect(() => {
    loadThreads();
  }, [loadThreads]);

  return (
    <section>
      <div className="mb-3">
        <h2 className="text-lg font-semibold">Message Center</h2>
        <p className="text-sm text-dewey-mute">
          {isAdmin
            ? "Every conversation on the platform — template submissions, shares, and direct threads."
            : "Template submissions to the admin, templates shared with you, and your conversations."}
        </p>
      </div>

      {loading ? (
        <p className="text-dewey-mute">Loading…</p>
      ) : error ? (
        <p className="text-red-600">{error}</p>
      ) : threads.length === 0 ? (
        <p className="py-6 text-center text-sm text-dewey-mute">
          No conversations yet. Share or submit a template from the Coaching Canvas to start one.
        </p>
      ) : (
        <div className="flex h-[65vh] overflow-hidden rounded-lg border border-dewey-border">
          <ul className="w-2/5 min-w-[180px] divide-y divide-dewey-border overflow-y-auto border-r border-dewey-border bg-dewey-surface">
            {threads.map((t) => (
              <ThreadListItem
                key={t.id}
                thread={t}
                meId={meId}
                active={t.id === activeId}
                onSelect={() => setActiveId(t.id)}
              />
            ))}
          </ul>
          <div className="flex min-w-0 flex-1 flex-col bg-dewey-cream">
            {activeId == null ? (
              <div className="flex flex-1 items-center justify-center text-sm text-dewey-mute">
                Select a conversation.
              </div>
            ) : (
              <ThreadPane
                threadId={activeId}
                meId={meId}
                onPreview={setPreview}
                onPosted={loadThreads}
              />
            )}
          </div>
        </div>
      )}

      {preview && <AttachmentLightbox attachment={preview} onClose={() => setPreview(null)} />}
    </section>
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
  onPreview,
  onPosted,
}: {
  threadId: number;
  meId: number | null;
  onPreview: (a: AttachmentMeta) => void;
  onPosted: () => void;
}) {
  const [thread, setThread] = useState<ThreadSummary | null>(null);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [loading, setLoading] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await apiFetch<{ thread: ThreadSummary; messages: MessageView[] }>(
        `/api/messages/threads/${threadId}`
      );
      setThread(d.thread);
      setMessages(d.messages);
    } catch {
      setThread(null);
      setMessages([]);
    } finally {
      setLoading(false);
    }
  }, [threadId]);

  useEffect(() => {
    load();
  }, [load]);

  // Scroll to the newest message after messages render.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onSent = useCallback(() => {
    load();
    onPosted();
  }, [load, onPosted]);

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
        </div>
        {thread && thread.participants.length > 0 && (
          <p className="truncate text-xs text-dewey-mute">
            {thread.participants.map((p) => p.full_name).join(", ")}
          </p>
        )}
      </div>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {loading ? (
          <p className="text-xs text-dewey-mute">Loading…</p>
        ) : messages.length === 0 ? (
          <p className="text-xs text-dewey-mute">No messages yet.</p>
        ) : (
          messages.map((m) => (
            <MessageBubble key={m.id} message={m} mine={m.sender_id === meId} onPreview={onPreview} />
          ))
        )}
      </div>

      <Composer threadId={threadId} onSent={onSent} />
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
      <div className={`max-w-[80%] ${mine ? "items-end" : "items-start"}`}>
        <div className="mb-0.5 flex items-center gap-2 text-[11px] text-dewey-mute">
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
      alert(e instanceof Error ? e.message : "Failed to send");
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
