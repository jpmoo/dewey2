import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { SignOutButton } from "@/components/SignOutButton";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ProfileButton } from "@/components/ProfileButton";
import { CoachTabs } from "@/components/coach/CoachTabs";
import { CelebrationGate } from "@/components/CelebrationGate";

export const dynamic = "force-dynamic";

/**
 * Coach workspace. Tabbed shell: message center, partnerships, partner
 * directory, and the coaching canvas (the coach's template builder).
 */
export default async function CoachPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect("/login");
  // Admins (not impersonating) belong in the console.
  if (session.user.system_role === "admin") redirect("/admin");
  // Partners have their own workspace.
  if (session.user.system_role === "partner") redirect("/partner");
  // Site / Deputy Site Leaders have the leader workspace.
  if (session.user.system_role === "site_leader" || session.user.system_role === "deputy_site_leader")
    redirect("/leader");
  // District Leaders have their own oversight workspace.
  if (session.user.system_role === "district_leader") redirect("/district");

  return (
    <div className="min-h-screen bg-dewey-cream text-dewey-ink flex flex-col">
      <header className="border-b border-dewey-border pl-16 pr-6 h-16 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">Coach</h1>
          <span className="text-sm text-dewey-mute">
            {session.user.nickname || session.user.name}
          </span>
        </div>
        <div className="flex items-center gap-4">
          <ThemeToggle />
          <ProfileButton />
          <SignOutButton />
        </div>
      </header>
      <main className="flex-1 px-6 py-6 max-w-3xl w-full mx-auto">
        <CoachTabs />
      </main>
      <CelebrationGate />
    </div>
  );
}
