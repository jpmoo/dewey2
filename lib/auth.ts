import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { getUserWithHashByUsername } from "@/lib/db";
import type { SystemRole } from "@/lib/db";
import { verifyPassword } from "@/lib/password";

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
    async jwt({ token, user }) {
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
      }
      return session;
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
