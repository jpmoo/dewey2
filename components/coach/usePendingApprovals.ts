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

export type UnreadThread = {
  threadId: number;
  name: string;
  lastMessage: string | null;
  lastSender: string | null;
  updatedAt: string;
};

export type CoachDashboard = { pending: PendingApproval[]; unread: UnreadThread[] };

/** Polls the coach's dashboard: pending approvals + threads with unread messages. */
export function useCoachDashboard(intervalMs = 8000): CoachDashboard {
  const [data, setData] = useState<CoachDashboard>({ pending: [], unread: [] });
  useEffect(() => {
    let cancelled = false;
    const tick = () =>
      apiFetch<CoachDashboard>("/api/coach/dashboard")
        .then((d) => {
          if (!cancelled) setData({ pending: d.pending ?? [], unread: d.unread ?? [] });
        })
        .catch(() => {});
    tick();
    const t = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [intervalMs]);
  return data;
}
