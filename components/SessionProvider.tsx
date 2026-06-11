"use client";

import { SessionProvider as NextAuthSessionProvider } from "next-auth/react";
import { ReactNode } from "react";

// Point the NextAuth client at the base-path-aware auth route so signIn/signOut
// and session polling work when the app is served under a sub-path.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH?.replace(/\/$/, "");
const authBasePath = basePath ? `${basePath}/api/auth` : undefined;

export function SessionProvider({ children }: { children: ReactNode }) {
  return (
    <NextAuthSessionProvider basePath={authBasePath}>
      {children}
    </NextAuthSessionProvider>
  );
}
