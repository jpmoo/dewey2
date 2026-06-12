import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { SignOutButton } from "@/components/SignOutButton";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ProfileButton } from "@/components/ProfileButton";
import { CoachTabs } from "@/components/coach/CoachTabs";

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
          <ThemeToggle className="text-sm text-dewey-mute hover:text-dewey-ink" />
          <ProfileButton className="text-sm text-dewey-mute hover:text-dewey-ink" />
          <SignOutButton className="text-sm text-dewey-mute hover:text-dewey-ink" />
        </div>
      </header>
      <main className="flex-1 px-6 py-6 max-w-3xl w-full mx-auto">
        <CoachTabs />
      </main>
    </div>
  );
}
