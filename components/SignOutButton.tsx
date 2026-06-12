"use client";

import { signOut } from "next-auth/react";
import { rootPath } from "@/lib/base-path";
import { useDialog } from "@/components/DialogProvider";

/**
 * Sign out via the NextAuth client, which posts to the base-path-aware auth
 * endpoint (configured in SessionProvider) and then lands on the dispatcher,
 * which sends a signed-out visitor to /login. Using signOut() rather than a
 * hand-built link avoids base-path URL mismatches.
 */
export function SignOutButton({ className }: { className?: string }) {
  const dialog = useDialog();
  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        if (await dialog.confirm("Sign out of Dewey?", { title: "Sign out" }))
          signOut({ callbackUrl: rootPath });
      }}
    >
      Sign out
    </button>
  );
}
