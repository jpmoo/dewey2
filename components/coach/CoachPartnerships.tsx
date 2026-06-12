"use client";

import { useCallback, useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { apiFetch } from "@/lib/api-client";
import { Avatar } from "@/components/Avatar";
import { ThreadPane, AttachmentLightbox } from "@/components/messages/MessageCenter";

type Member = { id: number; full_name: string; accepted: boolean | null };
type Partnership = { thread_id: number; created_at: string; members: Member[] };
type Recipient = { id: number; full_name: string; username: string; system_role: string };
type AttachmentMeta = { id: number; filename: string; mime_type: string; size_bytes: number };

/**
 * Coach Partnerships tab. Create a partnership with one or more partners (who
 * each get a yes/no invitation), and review existing partnerships as cards.
 */
export function CoachPartnerships() {
  const { data: session } = useSession();
  const meId = session?.user?.id ? Number(session.user.id) : null;
  const [items, setItems] = useState<Partnership[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const { partnerships } = await apiFetch<{ partnerships: Partnership[] }>("/api/partnerships");
      setItems(partnerships);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <section>
      <div className="mb-4">
        <h2 className="text-lg font-semibold">Partnerships</h2>
        <p className="text-sm text-dewey-mute">
          A coaching partnership with one or more partners. Invitees accept before they join the
          thread.
        </p>
        <div className="mt-3 flex justify-center">
          <button type="button" className="dewey-btn-secondary" onClick={() => setCreating(true)}>
            + New partnership
          </button>
        </div>
      </div>

      {loading ? (
        <p className="text-dewey-mute">Loading…</p>
      ) : items.length === 0 ? (
        <p className="py-6 text-center text-sm text-dewey-mute">
          No partnerships yet. Create one to invite partners.
        </p>
      ) : (
        <div className="space-y-3">
          {items.map((p) => (
            <button
              key={p.thread_id}
              type="button"
              onClick={() => setOpen(p.thread_id)}
              className="block w-full rounded-lg border border-dewey-border bg-dewey-surface p-4 text-left hover:bg-dewey-surface-2"
            >
              <div className="text-xs text-dewey-mute">
                Started {new Date(p.created_at).toLocaleDateString()}
              </div>
              <div className="mt-3 flex flex-wrap gap-4">
                {p.members.map((m) => (
                  <div key={m.id} className="flex w-16 flex-col items-center gap-1 text-center">
                    <Avatar userId={m.id} name={m.full_name} size={40} />
                    <span className="truncate text-[11px] text-dewey-ink" title={m.full_name}>
                      {m.full_name.split(" ")[0]}
                    </span>
                    {m.accepted === null && (
                      <span className="text-[9px] uppercase text-amber-700">pending</span>
                    )}
                    {m.accepted === false && (
                      <span className="text-[9px] uppercase text-red-600">declined</span>
                    )}
                  </div>
                ))}
              </div>
            </button>
          ))}
        </div>
      )}

      {creating && (
        <NewPartnershipModal
          onClose={() => setCreating(false)}
          onCreated={async () => {
            setCreating(false);
            await load();
          }}
        />
      )}
      {open !== null && (
        <PartnershipModal threadId={open} meId={meId} onClose={() => setOpen(null)} />
      )}
    </section>
  );
}

function NewPartnershipModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [partners, setPartners] = useState<Recipient[]>([]);
  const [selected, setSelected] = useState<Recipient[]>([]);
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ recipients: Recipient[] }>("/api/messages/recipients")
      .then((d) => setPartners(d.recipients.filter((r) => r.system_role === "partner")))
      .catch(() => setPartners([]))
      .finally(() => setLoading(false));
  }, []);

  const q = query.trim().toLowerCase();
  const selectedIds = new Set(selected.map((r) => r.id));
  const matches = partners
    .filter((r) => !selectedIds.has(r.id))
    .filter((r) => (q ? `${r.full_name} ${r.username}`.toLowerCase().includes(q) : true))
    .slice(0, 8);

  const send = async () => {
    if (selected.length === 0) {
      setErr("Add at least one partner.");
      return;
    }
    setSending(true);
    setErr(null);
    try {
      await apiFetch("/api/coach/partnerships", {
        method: "POST",
        body: { partnerIds: selected.map((r) => r.id), message },
      });
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to create partnership");
      setSending(false);
    }
  };

  return (
    <Shell title="New partnership" onClose={onClose}>
      <div className="space-y-4">
        {err && <p className="text-sm text-red-600">{err}</p>}
        <div>
          <label className="dewey-label">Partners</label>
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
                    onClick={() => setSelected((cur) => cur.filter((s) => s.id !== r.id))}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          {loading ? (
            <p className="text-sm text-dewey-mute">Loading…</p>
          ) : partners.length === 0 ? (
            <p className="text-sm text-dewey-mute">No partners available to invite.</p>
          ) : (
            <div className="relative">
              <input
                className="dewey-input"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search partners by name or username…"
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
                          onClick={() => {
                            setSelected((cur) => [...cur, r]);
                            setQuery("");
                          }}
                        >
                          <span className="font-medium text-dewey-ink">{r.full_name}</span>
                          <span className="ml-1 text-xs text-dewey-mute">@{r.username}</span>
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
          <label className="dewey-label">Invitation message (optional)</label>
          <textarea
            className="dewey-input min-h-[80px]"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="What this partnership is about…"
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
            disabled={sending || selected.length === 0}
          >
            {sending ? "Sending…" : "Send invitations"}
          </button>
        </div>
      </div>
    </Shell>
  );
}

function PartnershipModal({
  threadId,
  meId,
  onClose,
}: {
  threadId: number;
  meId: number | null;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<AttachmentMeta | null>(null);
  return (
    <Shell title="Partnership" onClose={onClose} wide>
      <div className="flex h-[60vh] flex-col overflow-hidden rounded-lg border border-dewey-border">
        <ThreadPane
          threadId={threadId}
          meId={meId}
          archived={false}
          onPreview={setPreview}
          onPosted={() => {}}
          onArchived={onClose}
        />
      </div>
      {preview && <AttachmentLightbox attachment={preview} onClose={() => setPreview(null)} />}
    </Shell>
  );
}

function Shell({
  title,
  children,
  onClose,
  wide,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className={`max-h-[90vh] w-full overflow-y-auto rounded-lg bg-dewey-surface p-6 shadow-xl ${
          wide ? "max-w-2xl" : "max-w-lg"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">{title}</h3>
          <button
            type="button"
            className="text-sm text-dewey-mute hover:text-dewey-ink"
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
