"use client";

import { useState } from "react";
import { MessageCenter } from "@/components/messages/MessageCenter";
import { ProgressReport } from "@/components/ProgressReport";
import { useUnreadCount } from "@/components/messages/useUnreadCount";

type Tab = "messages" | "progress";

const TABS: { id: Tab; label: string }[] = [
  { id: "messages", label: "Message Center" },
  { id: "progress", label: "Progress" },
];

/** Workspace for Site Leaders / Deputy Site Leaders: they're coached like a
 *  partner (Message Center) and can see their school's Progress report. */
export function LeaderTabs() {
  const [tab, setTab] = useState<Tab>("messages");
  const unread = useUnreadCount();

  return (
    <div>
      <nav className="mb-6 flex gap-1 border-b border-dewey-border" role="tablist">
        {TABS.map((t) => {
          const active = tab === t.id;
          const dot = t.id === "messages" && unread > 0;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(t.id)}
              className={`-mb-px flex items-center gap-1.5 border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
                active
                  ? "border-dewey-accent text-dewey-ink"
                  : "border-transparent text-dewey-mute hover:text-dewey-ink"
              }`}
            >
              {t.label}
              {dot && <span className="h-2 w-2 rounded-full bg-dewey-accent" aria-label="unread" />}
            </button>
          );
        })}
      </nav>

      {tab === "messages" && <MessageCenter />}
      {tab === "progress" && <ProgressReport />}
    </div>
  );
}
