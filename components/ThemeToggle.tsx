"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api-client";

/**
 * Per-user light/dark toggle. The choice is saved to the user's account
 * (users.settings.theme) so it persists across logins and devices, overriding
 * the admin default. The server applies it on load (see the root layout); this
 * just flips the <html> `dark` class immediately and saves the choice.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    // Reflect whatever the server already applied.
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  const toggle = async () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      await apiFetch("/api/me/theme", {
        method: "POST",
        body: { theme: next ? "dark" : "light" },
      });
    } catch {
      /* The visual toggle still applies for this session even if the save fails. */
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      className={`inline-flex items-center gap-1.5 rounded-full border border-dewey-accent/40 bg-dewey-accent/5 px-3 py-1 text-sm text-dewey-accent transition-colors hover:bg-dewey-accent/10 ${className ?? ""}`}
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      title={dark ? "Switch to light theme" : "Switch to dark theme"}
    >
      <span aria-hidden>{dark ? "🔆" : "🌙"}</span>
      {dark ? "Light" : "Dark"}
    </button>
  );
}
