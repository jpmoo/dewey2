"use client";

import { useEffect, useState } from "react";

const STORAGE_KEY = "dewey-theme";

/**
 * Per-user light/dark toggle. The choice is saved to localStorage and overrides
 * the admin's default theme (which is applied as the fallback by the inline
 * bootstrap script in the root layout). The <html> `dark` class drives the
 * CSS-variable palette.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    // Reflect whatever the bootstrap script already applied.
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem(STORAGE_KEY, next ? "dark" : "light");
    } catch {
      /* ignore storage failures (private mode, etc.) */
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      className={className}
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      title={dark ? "Switch to light theme" : "Switch to dark theme"}
    >
      {dark ? "☀ Light" : "☾ Dark"}
    </button>
  );
}
