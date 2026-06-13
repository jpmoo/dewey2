"use client";

import { useState } from "react";
import { CoachDashboard } from "./CoachDashboard";
import { CoachDirectory } from "./CoachDirectory";
import { CoachTemplates } from "./CoachTemplates";
import { MessageCenter } from "@/components/messages/MessageCenter";
import { useUnreadCount } from "@/components/messages/useUnreadCount";
import { useCoachDashboard } from "./usePendingApprovals";

type Tab = "dashboard" | "messages" | "directory" | "canvas";

const TABS: { id: Tab; label: string }[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "messages", label: "Message Center" },
  { id: "directory", label: "Partner Directory" },
  { id: "canvas", label: "Coaching Canvas" },
];

/** Tabbed shell for the coach workspace. Panels mount only when active. */
export function CoachTabs() {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [openThreadId, setOpenThreadId] = useState<number | null>(null);
  const unread = useUnreadCount();
  const { pending, unread: unreadThreads } = useCoachDashboard();

  const openThread = (id: number) => {
    // A new object identity each time so MessageCenter re-opens even the same id.
    setOpenThreadId(id);
    setTab("messages");
  };

  return (
    <div>
      <nav className="flex gap-1 border-b border-dewey-border mb-6" role="tablist">
        {TABS.map((t) => {
          const active = tab === t.id;
          const dot =
            (t.id === "dashboard" && pending.length > 0) ||
            (t.id === "messages" && unread > 0);
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                active
                  ? "border-dewey-accent text-dewey-ink"
                  : "border-transparent text-dewey-mute hover:text-dewey-ink"
              }`}
            >
              {t.label}
              {dot && (
                <span
                  className="h-2 w-2 rounded-full bg-dewey-accent"
                  aria-label="needs attention"
                />
              )}
            </button>
          );
        })}
      </nav>

      {tab === "dashboard" && (
        <CoachDashboard pending={pending} unread={unreadThreads} onOpenThread={openThread} />
      )}
      {tab === "messages" && <MessageCenter openThreadId={openThreadId} />}
      {tab === "directory" && <CoachDirectory />}
      {tab === "canvas" && <CoachTemplates />}
    </div>
  );
}
