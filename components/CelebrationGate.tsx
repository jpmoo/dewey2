"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api-client";
import { Fireworks } from "@/components/Fireworks";

type Celebration = {
  id: number;
  threadId: number;
  threadName: string;
  event: "advance" | "finish";
  body: string;
  createdAt: string;
};

const SEEN_KEY = "dewey-fw-seen";

/**
 * On load, if any activity/phase/plan completion happened in the user's threads
 * that they haven't already celebrated, throw up a fireworks modal — BIG when a
 * whole plan finished. Deduped per-browser against the same seen-set the in-chat
 * fireworks use, so nothing fires twice.
 */
export function CelebrationGate() {
  const [items, setItems] = useState<Celebration[] | null>(null);
  const [big, setBig] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ celebrations: Celebration[] }>("/api/messages/celebrations")
      .then((d) => {
        if (cancelled) return;
        try {
          const seen = new Set<number>(JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]"));
          const fresh = (d.celebrations ?? []).filter((c) => !seen.has(c.id));
          if (fresh.length === 0) return;
          fresh.forEach((c) => seen.add(c.id));
          localStorage.setItem(SEEN_KEY, JSON.stringify(Array.from(seen)));
          // Keep the in-chat fireworks' since-gate consistent.
          if (!localStorage.getItem("dewey-fw-since")) {
            localStorage.setItem("dewey-fw-since", String(Date.now()));
          }
          setBig(fresh.some((c) => c.event === "finish"));
          setItems(fresh);
        } catch {
          /* localStorage unavailable — skip */
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
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
            {big ? "🎉 Plan complete!" : "🎉 Progress while you were away"}
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
