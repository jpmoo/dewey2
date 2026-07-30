import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { SignOutButton } from "@/components/SignOutButton";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ProfileButton } from "@/components/ProfileButton";
import { LeaderTabs } from "@/components/leader/LeaderTabs";
import { CelebrationGate } from "@/components/CelebrationGate";

export const dynamic = "force-dynamic";

const LEADER_TITLE: Record<string, string> = {
  site_leader: "Site Leader",
  deputy_site_leader: "Deputy Site Leader",
};

/**
 * Site Leader / Deputy Site Leader workspace: coached like a partner (Message
 * Center) plus the school Progress report.
 */
export default async function LeaderPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect("/login");
  const role = session.user.system_role;
  if (role === "admin") redirect("/admin");
  if (role === "coach") redirect("/coach");
  if (role === "partner") redirect("/partner");
  if (role === "district_leader") redirect("/district");

  return (
    <div className="flex min-h-screen flex-col bg-dewey-cream text-dewey-ink">
      <header className="flex h-16 items-center justify-between border-b border-dewey-border pl-16 pr-6">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">{LEADER_TITLE[role] ?? "Leader"}</h1>
          <span className="text-sm text-dewey-mute">{session.user.nickname || session.user.name}</span>
        </div>
        <div className="flex items-center gap-4">
          <ThemeToggle />
          <ProfileButton />
          <SignOutButton />
        </div>
      </header>
      <main className="w-full flex-1 px-6 py-6">
        <LeaderTabs />
      </main>
      <CelebrationGate />
    </div>
  );
}
