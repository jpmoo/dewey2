"use client";

import { useState } from "react";
import { AdminSettings } from "./AdminSettings";
import { AdminOrgManager } from "./AdminOrgManager";
import { AdminUserManager } from "./AdminUserManager";

type Tab = "system" | "organization" | "users";

const TABS: { id: Tab; label: string }[] = [
  { id: "system", label: "System" },
  { id: "organization", label: "Organization" },
  { id: "users", label: "Users" },
];

/**
 * Tabbed shell for the admin console. Each panel is mounted only when active,
 * so its data loads on first view (and refreshes when revisited).
 */
export function AdminTabs() {
  const [tab, setTab] = useState<Tab>("system");

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

      {tab === "system" && <AdminSettings />}
      {tab === "organization" && <AdminOrgManager />}
      {tab === "users" && <AdminUserManager />}
    </div>
  );
}
