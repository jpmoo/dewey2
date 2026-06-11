import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { signOutPath } from "@/lib/routes";
import { authOptions } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Placeholder home for coach/partner accounts. The coaching workspace (plan
 * builder, message center, activities) is built in later phases — for now this
 * confirms auth + role routing works end to end.
 */
export default async function WorkspacePage() {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect("/login");
  if (session.user.system_role === "admin") redirect("/admin");

  const { user } = session;
  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="max-w-md w-full rounded-xl border border-dewey-border bg-white/60 p-8 text-center">
        <p className="text-sm text-dewey-mute uppercase tracking-wide mb-2">
          {user.system_role}
        </p>
        <h1 className="text-2xl font-semibold mb-2">
          Welcome, {user.nickname || user.name}
        </h1>
        <p className="text-dewey-mute text-sm mb-6">
          Your coaching workspace is coming soon. The admin console is where plans
          and accounts are managed today.
        </p>
        <a href={signOutPath()} className="text-sm text-dewey-accent hover:underline">
          Sign out
        </a>
      </div>
    </main>
  );
}
