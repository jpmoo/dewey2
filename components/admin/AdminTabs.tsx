"use client";

import { useState } from "react";
import { AdminSettings } from "./AdminSettings";
import { AdminOrgManager } from "./AdminOrgManager";
import { AdminUserManager } from "./AdminUserManager";
import { AdminTemplates } from "./AdminTemplates";
import { MessageCenter } from "@/components/messages/MessageCenter";
import { useUnreadCount } from "@/components/messages/useUnreadCount";

type Tab = "system" | "organization" | "users" | "templates" | "messages";

const TABS: { id: Tab; label: string }[] = [
  { id: "system", label: "System" },
  { id: "organization", label: "Organization" },
  { id: "users", label: "Users" },
  { id: "templates", label: "Coaching Canvas" },
  { id: "messages", label: "Messages" },
];

/**
 * Tabbed shell for the admin console. Each panel is mounted only when active,
 * so its data loads on first view (and refreshes when revisited).
 */
export function AdminTabs() {
  const [tab, setTab] = useState<Tab>("system");
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

      {tab === "system" && <AdminSettings />}
      {tab === "organization" && <AdminOrgManager />}
      {tab === "users" && <AdminUserManager />}
      {tab === "templates" && <AdminTemplates />}
      {tab === "messages" && <MessageCenter />}
    </div>
  );
}
