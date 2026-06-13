"use client";

import type { PendingApproval, UnreadThread } from "./usePendingApprovals";

/**
 * Coach home: submissions awaiting review and threads with unread messages.
 * Each item links straight to its conversation.
 */
export function CoachDashboard({
  pending,
  unread,
  onOpenThread,
}: {
  pending: PendingApproval[];
  unread: UnreadThread[];
  onOpenThread: (threadId: number) => void;
}) {
  return (
    <div className="max-w-3xl space-y-6">
      <section>
        <h2 className="mb-1 text-lg font-semibold">Dashboard</h2>
        <p className="mb-3 text-sm text-dewey-mute">Submissions waiting for your review.</p>
        {pending.length === 0 ? (
          <div className="rounded-lg border border-dewey-border bg-dewey-surface px-4 py-6 text-center text-sm text-dewey-mute">
            🎉 No submissions waiting for review.
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
      </section>

      <section>
        <h3 className="mb-1 text-sm font-semibold text-dewey-ink">Unread messages</h3>
        <p className="mb-3 text-xs text-dewey-mute">Conversations with new messages for you.</p>
        {unread.length === 0 ? (
          <div className="rounded-lg border border-dewey-border bg-dewey-surface px-4 py-6 text-center text-sm text-dewey-mute">
            You&apos;re all caught up.
          </div>
        ) : (
          <ul className="space-y-2">
            {unread.map((t) => (
              <li key={t.threadId}>
                <button
                  type="button"
                  onClick={() => onOpenThread(t.threadId)}
                  className="flex w-full items-center justify-between gap-3 rounded-lg border border-dewey-border bg-dewey-surface px-4 py-3 text-left hover:bg-dewey-surface-2"
                >
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5">
                      <span className="h-2 w-2 shrink-0 rounded-full bg-dewey-accent" aria-label="unread" />
                      <span className="truncate text-sm font-medium text-dewey-ink">{t.name}</span>
                    </span>
                    {t.lastMessage && (
                      <span className="mt-0.5 block truncate text-xs text-dewey-mute">
                        {t.lastSender ? `${t.lastSender}: ` : ""}
                        {t.lastMessage}
                      </span>
                    )}
                  </span>
                  <span className="flex shrink-0 items-center gap-1 rounded-full border border-dewey-accent/40 bg-dewey-accent/5 px-2 py-0.5 text-[11px] text-dewey-accent">
                    Open
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
