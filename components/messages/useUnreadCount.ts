"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api-client";

/** Polls the user's unread-thread count (for badging the Messages tab). */
export function useUnreadCount(intervalMs = 8000): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const tick = () =>
      apiFetch<{ count: number }>("/api/messages/unread-count")
        .then((d) => {
          if (!cancelled) setCount(d.count ?? 0);
        })
        .catch(() => {});
    tick();
    const t = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [intervalMs]);
  return count;
}
