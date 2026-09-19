"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { apiFetch } from "@/lib/api-client";
import { pathWithBase } from "@/lib/base-path";
import { useDialog } from "@/components/DialogProvider";

type Turn = { role: "user" | "assistant"; content: string; sources?: { name: string; path: string }[] };

/**
 * A private side panel where one person chats with @dewey about the open
 * conversation. Nothing here is visible to the group until they "Share to thread".
 */
export function DeweyPanel({
  threadId,
  seed,
  onClose,
  onShared,
}: {
  threadId: number;
  /** A question deposited from the main composer (auto-sent once). */
  seed?: string | null;
  onClose: () => void;
  onShared: () => void;
}) {
  const dialog = useDialog();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [sharing, setSharing] = useState(false);
  const lastSeed = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    apiFetch<{ messages: Turn[] }>(`/api/messages/threads/${threadId}/dewey`)
      .then((d) => setTurns(d.messages))
      .catch(() => setTurns([]));
  }, [threadId]);

  const send = useCallback(
    async (text: string) => {
      const q = text.trim();
      if (!q || loading) return;
      setInput("");
      // Optimistic user turn + an empty assistant turn we stream into.
      setTurns((t) => [...t, { role: "user", content: q }, { role: "assistant", content: "" }]);
      setLoading(true);
      const patchAssistant = (patch: Partial<Turn>) =>
        setTurns((t) => {
          const c = t.slice();
          c[c.length - 1] = { ...c[c.length - 1], role: "assistant", ...patch };
          return c;
        });
      try {
        const res = await fetch(pathWithBase(`/api/messages/threads/${threadId}/dewey`), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: q }),
        });
        if (!res.ok || !res.body) {
          const d = await res.json().catch(() => ({}));
          throw new Error((d as { error?: string }).error || `HTTP ${res.status}`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let live = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let sep: number;
          while ((sep = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            const line = frame.split("\n").find((l) => l.startsWith("data:"));
            if (!line) continue;
            let ev: { type?: string; text?: string; sources?: { name: string; path: string }[]; error?: string };
            try {
              ev = JSON.parse(line.slice(5).trim());
            } catch {
              continue;
            }
            if (ev.type === "text" && ev.text) {
              live += ev.text;
              patchAssistant({ content: live });
            } else if (ev.type === "sources") {
              patchAssistant({ sources: ev.sources });
            } else if (ev.type === "error") {
              throw new Error(ev.error || "Assistant error");
            }
          }
        }
        if (!live.trim()) patchAssistant({ content: "Sorry — I couldn't reach the model just now." });
      } catch (e) {
        dialog.alert(e instanceof Error ? e.message : "Couldn't reach Dewey.");
        setTurns((t) => (t.length && t[t.length - 1].role === "assistant" && !t[t.length - 1].content ? t.slice(0, -1) : t));
      } finally {
        setLoading(false);
      }
    },
    [threadId, loading, dialog]
  );

  const clear = async () => {
    if (turns.length === 0) return;
    if (!(await dialog.confirm(
      "Clear this Dewey conversation? Snapshots you've already shared stay; any live share becomes empty.",
      { title: "Clear conversation", confirmText: "Clear", danger: true }
    ))) return;
    try {
      await apiFetch(`/api/messages/threads/${threadId}/dewey`, { method: "DELETE" });
      setTurns([]);
      onShared();
    } catch (e) {
      dialog.alert(e instanceof Error ? e.message : "Couldn't clear.");
    }
  };

  // Auto-send a question deposited from the main composer (also when a new one
  // arrives while the panel is already open).
  useEffect(() => {
    if (seed && seed.trim() && seed !== lastSeed.current) {
      lastSeed.current = seed;
      send(seed);
    }
  }, [seed, send]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, loading]);

  const share = async (mode: "snapshot" | "live") => {
    if (turns.length === 0) return dialog.alert("Ask Dewey something first.");
    setSharing(true);
    try {
      await apiFetch(`/api/messages/threads/${threadId}/dewey/share`, { method: "POST", body: { mode } });
      onShared();
    } catch (e) {
      dialog.alert(e instanceof Error ? e.message : "Couldn't share.");
    } finally {
      setSharing(false);
    }
  };

  return (
    <div className="fixed right-0 top-[var(--imp-h)] bottom-0 z-40 flex w-full max-w-md flex-col border-l border-dewey-border bg-dewey-surface shadow-xl">
      <div className="flex items-center justify-between gap-2 border-b border-dewey-border px-4 py-2">
        <div className="flex items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={pathWithBase("/logo.png")} alt="" className="h-5 w-5 object-contain" />
          <span className="text-sm font-semibold text-dewey-ink">Chat with Dewey</span>
          <span className="rounded-full bg-dewey-surface-2 px-2 py-0.5 text-[10px] text-dewey-mute">Private</span>
        </div>
        <div className="flex items-center gap-3">
          {turns.length > 0 && (
            <button type="button" className="text-xs text-dewey-mute hover:text-red-700" onClick={clear}>
              Clear
            </button>
          )}
          <button type="button" className="text-dewey-mute hover:text-dewey-ink" onClick={onClose}>✕</button>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {turns.length === 0 && !loading && (
          <p className="text-sm text-dewey-mute">
            Ask Dewey anything about this conversation. Only you can see this until you share it.
          </p>
        )}
        {turns.map((t, i) => (
          <div key={i} className={t.role === "user" ? "flex justify-end" : "flex justify-start"}>
            <div
              className={`max-w-[85%] rounded-lg border px-3 py-2 text-sm ${
                t.role === "user"
                  ? "border-dewey-accent/30 bg-dewey-accent/5"
                  : "border-dewey-border bg-dewey-surface-2"
              }`}
            >
              {t.role === "assistant" ? (
                <div className="chat-md">
                  <ReactMarkdown>{t.content}</ReactMarkdown>
                </div>
              ) : (
                <p className="whitespace-pre-wrap">{t.content}</p>
              )}
              {t.sources && t.sources.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1 border-t border-dewey-border pt-1.5">
                  {t.sources.map((s, j) => {
                    const href = /^https?:\/\//.test(s.path) ? s.path : pathWithBase(s.path);
                    return (
                      <a
                        key={j}
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="max-w-[160px] truncate rounded-full border border-dewey-accent/40 bg-dewey-accent/5 px-2 py-0.5 text-[11px] text-dewey-accent hover:underline"
                      >
                        {s.name}
                      </a>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        ))}
        {loading && <p className="text-xs text-dewey-mute">Dewey is thinking…</p>}
      </div>

      {turns.length > 0 && (
        <div className="flex items-center gap-2 border-t border-dewey-border px-4 py-2 text-xs">
          <span className="text-dewey-mute">Share to the group:</span>
          <button type="button" className="rounded-full border border-dewey-accent/40 bg-dewey-accent/5 px-2 py-0.5 text-dewey-accent hover:bg-dewey-accent/10 disabled:opacity-50" onClick={() => share("snapshot")} disabled={sharing}>
            Snapshot
          </button>
          <button type="button" className="rounded-full border border-dewey-accent/40 bg-dewey-accent/5 px-2 py-0.5 text-dewey-accent hover:bg-dewey-accent/10 disabled:opacity-50" onClick={() => share("live")} disabled={sharing}>
            Share &amp; keep live
          </button>
        </div>
      )}

      <div className="border-t border-dewey-border p-2">
        <div className="flex items-end gap-2">
          <textarea
            className="dewey-input min-h-[38px] max-h-32 flex-1 resize-none"
            placeholder="Ask Dewey…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
            disabled={loading}
          />
          <button type="button" className="dewey-btn-primary w-auto" onClick={() => send(input)} disabled={loading || !input.trim()}>
            ➤
          </button>
        </div>
      </div>
    </div>
  );
}
