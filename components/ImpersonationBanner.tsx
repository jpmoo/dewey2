"use client";

import { useState } from "react";
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

  if (!session?.user?.impersonating) return null;

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
    // z-[45] keeps the banner above normal page chrome — including the corner "D"
    // logo (z-40), which must sit behind this band — but BELOW full-screen
    // overlays/modals (z-50+), so it never covers a modal's top toolbar/commands.
    <div className="sticky top-0 z-[45] bg-amber-500 text-amber-950 px-4 py-2 flex items-center justify-between gap-3 text-sm shadow">
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
