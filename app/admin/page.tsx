import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions, isAdminSession } from "@/lib/auth";
import { SignOutButton } from "@/components/SignOutButton";
import { AdminSettings } from "@/components/admin/AdminSettings";
import { AdminUserManager } from "@/components/admin/AdminUserManager";
import { AdminOrgManager } from "@/components/admin/AdminOrgManager";
import { Logo } from "@/components/Logo";

export const dynamic = "force-dynamic";

/**
 * Admin console — the home screen for the dedicated admin account. Coaches and
 * partners never reach here; the dispatcher routes them to their workspace.
 */
export default async function AdminPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect("/login");
  // Non-admins (including an admin currently impersonating a coach/partner) get
  // routed to the right place by the dispatcher.
  if (!isAdminSession(session)) redirect("/");

  return (
    <div className="min-h-screen bg-dewey-cream text-dewey-ink flex flex-col">
      <header className="border-b border-dewey-border px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Logo size={26} />
          <h1 className="text-lg font-semibold">Admin</h1>
          <span className="text-sm text-dewey-mute">
            {session.user.nickname || session.user.name}
          </span>
        </div>
        <SignOutButton className="text-sm text-dewey-mute hover:text-dewey-ink" />
      </header>
      <main className="flex-1 px-6 py-6 max-w-3xl w-full mx-auto space-y-10">
        <AdminSettings />
        <AdminOrgManager />
        <AdminUserManager />
      </main>
    </div>
  );
}
