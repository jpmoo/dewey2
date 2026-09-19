"use client";

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { apiFetch } from "@/lib/api-client";

type Turn = { role: string; content: string };

/** Read-only viewer for a shared Dewey conversation bubble (snapshot or live). */
export function SharedDeweyModal({
  threadId,
  messageId,
  onClose,
}: {
  threadId: number;
  messageId: number;
  onClose: () => void;
}) {
  const [data, setData] = useState<{ mode: string | null; summary: string | null; turns: Turn[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ mode: string | null; summary: string | null; turns: Turn[] }>(
      `/api/messages/threads/${threadId}/dewey/shared/${messageId}`
    )
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Couldn't load"));
  }, [threadId, messageId]);

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/40 p-4" onClick={onClose}>
      <div className="my-8 w-full max-w-2xl rounded-lg border border-dewey-border bg-dewey-surface p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-semibold text-dewey-ink">
            Dewey conversation{" "}
            {data?.mode && (
              <span className="ml-1 rounded-full bg-dewey-surface-2 px-2 py-0.5 text-[10px] uppercase text-dewey-mute">
                {data.mode === "live" ? "live" : "snapshot"}
              </span>
            )}
          </h3>
          <button type="button" className="text-dewey-mute hover:text-dewey-ink" onClick={onClose}>✕</button>
        </div>
        {error ? (
          <p className="text-sm text-red-600">{error}</p>
        ) : !data ? (
          <p className="text-sm text-dewey-mute">Loading…</p>
        ) : data.turns.length === 0 ? (
          <p className="text-sm text-dewey-mute">This conversation is empty.</p>
        ) : (
          <div className="space-y-3">
            {data.turns.map((t, i) => (
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
                </div>
              </div>
            ))}
          </div>
        )}
        {data?.mode === "live" && (
          <p className="mt-3 text-xs text-dewey-mute">
            This is a live link — it reflects the latest of the sharer&apos;s Dewey chat.
          </p>
        )}
      </div>
    </div>
  );
}
