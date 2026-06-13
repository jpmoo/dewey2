"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api-client";
import { pathWithBase } from "@/lib/base-path";
import { Fireworks } from "@/components/Fireworks";

type Celebration = {
  id: number;
  threadId: number;
  threadName: string;
  event: "advance" | "finish";
  body: string;
  createdAt: string;
};

/**
 * Fireworks modal for activity/phase/plan completions the signed-in user hasn't
 * celebrated yet — BIG when a whole plan finished. "Seen" is tracked per user on
 * the server, so each participant gets their own celebration for the same event
 * (logging in after an approval, or while in the app — polled).
 */
export function CelebrationGate() {
  const [items, setItems] = useState<Celebration[] | null>(null);
  const [big, setBig] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      // Don't stack a new modal on top of one already showing.
      if (cancelled || items) return;
      try {
        const d = await apiFetch<{ celebrations: Celebration[] }>(
          "/api/messages/celebrations"
        );
        const fresh = d.celebrations ?? [];
        if (cancelled || fresh.length === 0) return;
        setBig(fresh.some((c) => c.event === "finish"));
        setItems(fresh);
        // Mark seen immediately so they won't re-fire on the next poll/login.
        await fetch(pathWithBase("/api/messages/celebrations/seen"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ids: fresh.map((c) => c.id) }),
        }).catch(() => {});
      } catch {
        /* ignore */
      }
    };
    check();
    const t = setInterval(check, 12000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
    // `items` intentionally omitted: the interval closure checks it via the guard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!items || items.length === 0) return null;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4"
      onClick={() => setItems(null)}
    >
      <div
        className="relative w-full max-w-md overflow-hidden rounded-xl border border-dewey-border bg-dewey-cream p-6 text-center shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <Fireworks big={big} onDone={() => {}} />
        <div className="relative z-10">
          <h2 className="text-xl font-bold text-dewey-ink">
            {big ? "🎉 Plan complete!" : "🎉 Progress to celebrate"}
          </h2>
          <ul className="mt-3 space-y-1.5 text-left text-sm text-dewey-ink">
            {items.map((c) => (
              <li key={c.id} className="rounded-md bg-dewey-surface px-3 py-2">
                <span className="font-medium">{c.threadName}:</span> {c.body}
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="dewey-btn-primary mt-4 w-auto"
            onClick={() => setItems(null)}
          >
            Nice!
          </button>
        </div>
      </div>
    </div>
  );
}
