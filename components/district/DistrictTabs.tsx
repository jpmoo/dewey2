"use client";

import { useState } from "react";
import { CoachDirectory } from "@/components/coach/CoachDirectory";
import { CoachTemplates } from "@/components/coach/CoachTemplates";
import { MessageCenter } from "@/components/messages/MessageCenter";
import { ProgressReport } from "@/components/ProgressReport";
import { useUnreadCount } from "@/components/messages/useUnreadCount";

type Tab = "messages" | "directory" | "canvas" | "progress";

const TABS: { id: Tab; label: string }[] = [
  { id: "messages", label: "Message Center" },
  { id: "directory", label: "Partner Directory" },
  { id: "canvas", label: "Coaching Canvas" },
  { id: "progress", label: "Progress" },
];

/**
 * District Leader workspace: a coach at their base, with district-wide oversight —
 * all messages across their district (admin-level actions), the district Partner
 * Directory, the Coaching Canvas, and the district Progress report. No Dashboard,
 * Organization, Users, or System.
 */
export function DistrictTabs() {
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
      {tab === "directory" && <CoachDirectory />}
      {tab === "canvas" && <CoachTemplates />}
      {tab === "progress" && <ProgressReport />}
    </div>
  );
}
