"use client";

import type { PendingApproval } from "./usePendingApprovals";

/**
 * Coach home: submissions awaiting review across every thread the coach is part
 * of. Each links straight to its conversation.
 */
export function CoachDashboard({
  pending,
  onOpenThread,
}: {
  pending: PendingApproval[];
  onOpenThread: (threadId: number) => void;
}) {
  return (
    <div className="max-w-3xl">
      <h2 className="mb-1 text-lg font-semibold">Dashboard</h2>
      <p className="mb-4 text-sm text-dewey-mute">
        Submissions waiting for your review.
      </p>

      {pending.length === 0 ? (
        <div className="rounded-lg border border-dewey-border bg-dewey-surface px-4 py-8 text-center text-sm text-dewey-mute">
          🎉 You&apos;re all caught up — no submissions waiting for review.
        </div>
      ) : (
        <ul className="space-y-2">
          {pending.map((p) => (
            <li key={p.submissionId}>
              <button
                type="button"
                onClick={() => onOpenThread(p.threadId)}
                className="flex w-full items-center justify-between gap-3 rounded-lg border border-dewey-border bg-dewey-surface px-4 py-3 text-left hover:bg-dewey-surface-2"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-dewey-ink">
                    {p.activityLabel}
                  </span>
                  <span className="block truncate text-xs text-dewey-mute">
                    {p.threadName}
                    {p.partnerName ? ` · ${p.partnerName}` : ""} ·{" "}
                    {new Date(p.createdAt).toLocaleDateString()}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1 rounded-full border border-dewey-accent/40 bg-dewey-accent/5 px-2 py-0.5 text-[11px] text-dewey-accent">
                  🔎 Review
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
