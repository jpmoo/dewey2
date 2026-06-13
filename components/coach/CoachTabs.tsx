"use client";

import { useState } from "react";
import { CoachDirectory } from "./CoachDirectory";
import { CoachTemplates } from "./CoachTemplates";
import { MessageCenter } from "@/components/messages/MessageCenter";
import { useUnreadCount } from "@/components/messages/useUnreadCount";

type Tab = "messages" | "directory" | "canvas";

const TABS: { id: Tab; label: string }[] = [
  { id: "messages", label: "Message Center" },
  { id: "directory", label: "Partner Directory" },
  { id: "canvas", label: "Coaching Canvas" },
];

/** Tabbed shell for the coach workspace. Panels mount only when active. */
export function CoachTabs() {
  const [tab, setTab] = useState<Tab>("messages");
  const unread = useUnreadCount();

  return (
    <div>
      <nav className="flex gap-1 border-b border-dewey-border mb-6" role="tablist">
        {TABS.map((t) => {
          const active = tab === t.id;
          const badge = t.id === "messages" && unread > 0;
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
              {badge && (
                <span className="inline-flex min-w-[18px] items-center justify-center rounded-full bg-dewey-accent px-1.5 text-[11px] font-semibold text-white">
                  {unread}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {tab === "messages" && <MessageCenter />}
      {tab === "directory" && <CoachDirectory />}
      {tab === "canvas" && <CoachTemplates />}
    </div>
  );
}
