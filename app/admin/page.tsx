import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions, isAdminSession } from "@/lib/auth";
import { SignOutButton } from "@/components/SignOutButton";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ProfileButton } from "@/components/ProfileButton";
import { AdminTabs } from "@/components/admin/AdminTabs";

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
      {/* h-16 + items-center vertically centers the title against the corner
          logo; pl clears that logo (rendered by the root layout). */}
      <header className="border-b border-dewey-border pl-16 pr-6 h-16 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">Admin</h1>
          <span className="text-sm text-dewey-mute">
            {session.user.nickname || session.user.name}
          </span>
        </div>
        <div className="flex items-center gap-4">
          <ThemeToggle className="text-sm text-dewey-mute hover:text-dewey-ink" />
          <ProfileButton className="text-sm text-dewey-mute hover:text-dewey-ink" />
          <SignOutButton className="text-sm text-dewey-mute hover:text-dewey-ink" />
        </div>
      </header>
      <main className="flex-1 px-6 py-6 max-w-3xl w-full mx-auto">
        <AdminTabs />
      </main>
    </div>
  );
}
