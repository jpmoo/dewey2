"use client";

import { signOut, useSession } from "next-auth/react";
import { pathWithBase, rootPath } from "@/lib/base-path";
import { useDialog } from "@/components/DialogProvider";

/**
 * Sign out via the NextAuth client, which posts to the base-path-aware auth
 * endpoint (configured in SessionProvider) and then lands on the dispatcher,
 * which sends a signed-out visitor to /login. Using signOut() rather than a
 * hand-built link avoids base-path URL mismatches.
 *
 * While an admin is impersonating a user, "Sign out" returns to the admin
 * account rather than ending the session — the admin's own session is still
 * live underneath, so signing out fully would be surprising.
 */
export function SignOutButton({ className }: { className?: string }) {
  const dialog = useDialog();
  const { data: session, update } = useSession();
  const impersonating = !!session?.user?.impersonating;

  return (
    <button
      type="button"
      className={`inline-flex items-center gap-1.5 rounded-full border border-dewey-border bg-dewey-surface px-3 py-1 text-sm text-dewey-mute transition-colors hover:bg-dewey-surface-2 hover:text-dewey-ink ${className ?? ""}`}
      onClick={async () => {
        if (impersonating) {
          if (
            !(await dialog.confirm("Return to your admin account?", { title: "Sign out" }))
          )
            return;
          await update({ action: "stop" });
          // Hard navigation so server components re-read the restored admin session.
          window.location.href = pathWithBase("/admin");
          return;
        }
        if (await dialog.confirm("Sign out of Dewey?", { title: "Sign out" }))
          signOut({ callbackUrl: rootPath });
      }}
    >
      <span aria-hidden>🚪</span> {impersonating ? "Exit" : "Sign out"}
    </button>
  );
}
