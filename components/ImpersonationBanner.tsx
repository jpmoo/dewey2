"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { pathWithBase } from "@/lib/base-path";

/**
 * Persistent bar shown whenever an admin is impersonating another user. Always
 * on screen (rendered in the root layout) so there is a guaranteed way back to
 * the admin account, regardless of what the impersonated role can/can't reach.
 */
export function ImpersonationBanner() {
  const { data: session, update } = useSession();
  const [leaving, setLeaving] = useState(false);
  const impersonating = !!session?.user?.impersonating;

  // Reserve top space (via --imp-h) while impersonating so full-screen overlays
  // sit below the banner instead of covering it.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("impersonating", impersonating);
    return () => root.classList.remove("impersonating");
  }, [impersonating]);

  if (!impersonating) return null;

  const { name, nickname, system_role, impersonatorName } = session.user;

  async function returnToAdmin() {
    setLeaving(true);
    try {
      await update({ action: "stop" });
      // Hard navigation so server components re-read the restored admin session.
      window.location.href = pathWithBase("/admin");
    } catch {
      setLeaving(false);
    }
  }

  return (
    // z-[80] keeps the bail-out band above everything — including full-screen
    // editors (z-50) and their modals — so there's always a way back to admin.
    // Full-screen overlays reserve --imp-h at the top so it never covers a toolbar.
    <div className="sticky top-0 z-[80] flex h-11 items-center justify-between gap-3 bg-amber-500 px-4 text-sm text-amber-950 shadow">
      <span>
        Viewing as <strong>{nickname || name}</strong>{" "}
        <span className="opacity-80">({system_role})</span>
        {impersonatorName && (
          <span className="opacity-80"> · signed in as {impersonatorName}</span>
        )}
      </span>
      <button
        type="button"
        onClick={returnToAdmin}
        disabled={leaving}
        className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-amber-950 px-3.5 py-1 text-amber-50 hover:opacity-90 disabled:opacity-50"
      >
        <span aria-hidden>↩︎</span> {leaving ? "Returning…" : "Return to admin"}
      </button>
    </div>
  );
}
