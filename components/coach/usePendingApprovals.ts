"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api-client";

export type PendingApproval = {
  submissionId: number;
  threadId: number;
  threadName: string;
  partnerName: string | null;
  activityLabel: string;
  createdAt: string;
};

/** Polls the coach's pending activity approvals (for the dashboard + its dot). */
export function usePendingApprovals(intervalMs = 8000): PendingApproval[] {
  const [items, setItems] = useState<PendingApproval[]>([]);
  useEffect(() => {
    let cancelled = false;
    const tick = () =>
      apiFetch<{ pending: PendingApproval[] }>("/api/coach/dashboard")
        .then((d) => {
          if (!cancelled) setItems(d.pending ?? []);
        })
        .catch(() => {});
    tick();
    const t = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [intervalMs]);
  return items;
}
