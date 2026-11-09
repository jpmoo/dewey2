import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getDistricts, getSchools } from "@/lib/db";
import { WelcomeForm } from "@/components/WelcomeForm";
import { Logo } from "@/components/Logo";

export const dynamic = "force-dynamic";

/**
 * First sign-in with a Google account that has no Dewey account yet: collect
 * name, nickname, title, and schools, then create the account. Anyone else is
 * sent back through the dispatcher.
 */
export default async function WelcomePage() {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect("/login");
  // Prefill from what Google shared.
  const pending = session.user.pendingSignup;
  if (!pending) redirect("/");

  const district = (await getDistricts())[0] ?? null;
  const schools = district ? await getSchools(district.id) : [];

  return (
    <main className="theme-light bg-dewey-cream text-dewey-ink min-h-screen flex items-center justify-center p-6">
      <div className="max-w-md w-full">
        <div className="text-center mb-6">
          <Logo size={72} className="mx-auto mb-4" />
          <h1 className="text-xl font-semibold">Welcome to Dewey</h1>
          <p className="mt-1 text-sm text-dewey-mute">
            Tell us a little about yourself to finish setting up your account.
          </p>
        </div>
        <WelcomeForm
          email={pending.email}
          defaultName={pending.name}
          defaultNickname={pending.givenName}
          districtName={district?.name ?? null}
          schools={schools.map((s) => ({ id: s.id, name: s.name }))}
        />
      </div>
    </main>
  );
}
