import { redirect } from "next/navigation";
import { hasAdmin } from "@/lib/db";
import { SetupForm } from "@/components/setup/SetupForm";
import { Logo } from "@/components/Logo";

export const dynamic = "force-dynamic";

/**
 * First-run admin creation screen. Once an admin exists this route is closed —
 * we send returning visitors to the login page instead.
 */
export default async function SetupPage() {
  if (await hasAdmin()) {
    redirect("/login");
  }
  return (
    <main className="theme-light bg-dewey-cream text-dewey-ink min-h-screen flex items-center justify-center p-6">
      <div className="max-w-md w-full">
        <div className="text-center mb-6">
          <Logo size={44} className="mx-auto mb-4" />
          <h1 className="text-2xl font-semibold mb-1">First-time setup</h1>
          <p className="text-sm text-dewey-mute text-balance">
            Create the dedicated administrator account. It manages users, the
            organization, and system configuration. Two demo accounts
            (<code>jcoach</code>, <code>jpartner</code>) are created automatically.
          </p>
        </div>
        <SetupForm />
      </div>
    </main>
  );
}
