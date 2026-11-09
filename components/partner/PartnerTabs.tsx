"use client";

import { useState } from "react";
import { MessageCenter } from "@/components/messages/MessageCenter";
import { CoachTemplates } from "@/components/coach/CoachTemplates";
import { useUnreadCount } from "@/components/messages/useUnreadCount";

type Tab = "messages" | "canvas";

const TABS: { id: Tab; label: string }[] = [
  { id: "messages", label: "Message Center" },
  { id: "canvas", label: "Coaching Canvas" },
];

/**
 * Partner workspace for a partner allowed to create communities: the Message
 * Center plus the Coaching Canvas, where they build plans for their communities.
 */
export function PartnerTabs() {
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
      {tab === "canvas" && <CoachTemplates canShare={false} />}
    </div>
  );
}
