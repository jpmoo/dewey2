import { redirect } from "next/navigation";
import { hasAdmin } from "@/lib/db";
import { SetupForm } from "@/components/setup/SetupForm";

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
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="max-w-md w-full">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-semibold mb-1">Set up Dewey</h1>
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
