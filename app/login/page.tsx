import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { hasAdmin } from "@/lib/db";
import { LoginForm } from "@/components/LoginForm";

export const dynamic = "force-dynamic";

/**
 * Sign-in screen. If no admin exists yet we divert to first-run setup; if the
 * visitor is already signed in we bounce them to the dispatcher.
 */
export default async function LoginPage() {
  if (!(await hasAdmin())) {
    redirect("/setup");
  }
  const session = await getServerSession(authOptions);
  if (session?.user) {
    redirect("/");
  }
  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="max-w-sm w-full">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-semibold mb-1">Dewey</h1>
          <p className="text-sm text-dewey-mute">Sign in to your account.</p>
        </div>
        <LoginForm />
      </div>
    </main>
  );
}
