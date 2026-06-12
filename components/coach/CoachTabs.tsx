"use client";

import { useState } from "react";
import { CoachDirectory } from "./CoachDirectory";
import { CoachTemplates } from "./CoachTemplates";
import { CoachPartnerships } from "./CoachPartnerships";
import { MessageCenter } from "@/components/messages/MessageCenter";

type Tab = "messages" | "partnerships" | "directory" | "canvas";

const TABS: { id: Tab; label: string }[] = [
  { id: "messages", label: "Message Center" },
  { id: "partnerships", label: "Partnerships" },
  { id: "directory", label: "Partner Directory" },
  { id: "canvas", label: "Coaching Canvas" },
];

/** Tabbed shell for the coach workspace. Panels mount only when active. */
export function CoachTabs() {
  const [tab, setTab] = useState<Tab>("messages");

  return (
    <div>
      <nav className="flex gap-1 border-b border-dewey-border mb-6" role="tablist">
        {TABS.map((t) => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(t.id)}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                active
                  ? "border-dewey-accent text-dewey-ink"
                  : "border-transparent text-dewey-mute hover:text-dewey-ink"
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </nav>

      {tab === "messages" && <MessageCenter />}
      {tab === "partnerships" && <CoachPartnerships />}
      {tab === "directory" && <CoachDirectory />}
      {tab === "canvas" && <CoachTemplates />}
    </div>
  );
}
