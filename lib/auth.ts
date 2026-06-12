import type { NextAuthOptions } from "next-auth";
import type { JWT } from "next-auth/jwt";
import CredentialsProvider from "next-auth/providers/credentials";
import { getUserById, getUserWithHashByUsername, logUserEvent } from "@/lib/db";
import type { SystemRole, User } from "@/lib/db";
import { verifyPassword } from "@/lib/password";

/** Copy a user's identity onto the JWT. Shared by sign-in and impersonation. */
function applyUserToToken(token: JWT, user: User): void {
  token.sub = String(user.id);
  token.name = user.full_name;
  token.email = user.email;
  token.username = user.username;
  token.nickname = user.nickname;
  token.system_role = user.system_role;
  token.district_id = user.district_id;
  token.school_id = user.school_id;
}

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      id: "dewey",
      name: "Dewey account",
      credentials: {
        username: { label: "Username", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.username || !credentials?.password) return null;
        const user = await getUserWithHashByUsername(credentials.username);
        if (!user) return null;
        const ok = await verifyPassword(credentials.password, user.password_hash);
        if (!ok) return null;
        await logUserEvent({ userId: user.id, actorId: user.id, action: "signed_in" });
        return {
          id: String(user.id),
          name: user.full_name,
          email: user.email,
          username: user.username,
          nickname: user.nickname,
          system_role: user.system_role,
          district_id: user.district_id,
          school_id: user.school_id,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user, trigger, session }) {
      // Fresh sign-in.
      if (user) {
        const u = user as typeof user & {
          username: string;
          nickname: string | null;
          system_role: SystemRole;
          district_id: number | null;
          school_id: number | null;
        };
        token.sub = u.id;
        token.username = u.username;
        token.nickname = u.nickname;
        token.system_role = u.system_role;
        token.district_id = u.district_id;
        token.school_id = u.school_id;
        return token;
      }

      // Impersonation: driven by the client calling session.update({ ... }).
      // The token is signed server-side, so these guards can't be bypassed.
      if (trigger === "update" && session && typeof session === "object") {
        const action = (session as { action?: string }).action;

        // Start impersonating: only a real admin who isn't already impersonating.
        if (action === "impersonate" && token.system_role === "admin" && !token.impersonatorId) {
          const targetId = Number((session as { userId?: unknown }).userId);
          if (Number.isFinite(targetId) && String(targetId) !== token.sub) {
            const target = await getUserById(targetId);
            if (target) {
              token.impersonatorId = token.sub;
              token.impersonatorName = (token.name as string) ?? token.username ?? "admin";
              applyUserToToken(token, target);
              await logUserEvent({
                userId: target.id,
                actorId: Number(token.impersonatorId),
                action: "impersonated",
                detail: `by ${token.impersonatorName}`,
              });
            }
          }
        }

        // Stop impersonating: restore the original admin. Allowed regardless of
        // the current (impersonated) role — the bail-out must always work.
        else if (action === "stop" && token.impersonatorId) {
          const admin = await getUserById(Number(token.impersonatorId));
          if (admin) {
            applyUserToToken(token, admin);
            delete token.impersonatorId;
            delete token.impersonatorName;
          }
        }

        // Reload the current identity from the DB (e.g. after a self profile
        // edit) so the name/nickname in the UI update without re-login.
        else if (action === "refresh") {
          const current = await getUserById(Number(token.sub));
          if (current) {
            const keepImpersonator = token.impersonatorId;
            const keepImpersonatorName = token.impersonatorName;
            applyUserToToken(token, current);
            if (keepImpersonator) {
              token.impersonatorId = keepImpersonator;
              token.impersonatorName = keepImpersonatorName;
            }
          }
        }
      }

      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.sub ?? "";
        session.user.username = (token.username as string) ?? "";
        session.user.nickname = (token.nickname as string | null) ?? null;
        session.user.system_role = (token.system_role as SystemRole) ?? "partner";
        session.user.district_id = (token.district_id as number | null) ?? null;
        session.user.school_id = (token.school_id as number | null) ?? null;
        // Surfaced so the UI can show the "viewing as…" banner and bail-out.
        session.user.impersonating = !!token.impersonatorId;
        session.user.impersonatorName = (token.impersonatorName as string | null) ?? null;
      }
      return session;
    },
  },
  events: {
    // Record sign-out against the (possibly impersonated) account in the token.
    async signOut({ token }) {
      const uid = Number(token?.sub);
      if (Number.isFinite(uid)) {
        await logUserEvent({ userId: uid, actorId: uid, action: "signed_out" });
      }
    },
  },
  pages: {
    signIn: "/login",
    error: "/login",
  },
  session: {
    strategy: "jwt",
    maxAge: 30 * 24 * 60 * 60, // 30 days
  },
  secret: process.env.NEXTAUTH_SECRET,
  debug: process.env.NODE_ENV === "development",
};

/** Convenience guard used by admin API routes and pages. */
export function isAdminSession(session: { user?: { system_role?: string } } | null): boolean {
  return session?.user?.system_role === "admin";
}
