import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { SignOutButton } from "@/components/SignOutButton";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ProfileButton } from "@/components/ProfileButton";
import { DistrictTabs } from "@/components/district/DistrictTabs";

export const dynamic = "force-dynamic";

/**
 * District Leader workspace. A coach at their base plus district-wide oversight of
 * messages, partners, and progress.
 */
export default async function DistrictPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect("/login");
  const role = session.user.system_role;
  if (role === "admin") redirect("/admin");
  if (role === "coach") redirect("/coach");
  if (role === "partner") redirect("/partner");
  if (role === "site_leader" || role === "deputy_site_leader") redirect("/leader");

  return (
    <div className="flex min-h-screen flex-col bg-dewey-cream text-dewey-ink">
      <header className="flex h-16 items-center justify-between border-b border-dewey-border pl-16 pr-6">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">District Leader</h1>
          <span className="text-sm text-dewey-mute">{session.user.nickname || session.user.name}</span>
        </div>
        <div className="flex items-center gap-4">
          <ThemeToggle />
          <ProfileButton />
          <SignOutButton />
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        <DistrictTabs />
      </main>
    </div>
  );
}
