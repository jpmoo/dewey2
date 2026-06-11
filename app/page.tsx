import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { hasAdmin } from "@/lib/db";

// Reads the DB and the session on every request — never prerender.
export const dynamic = "force-dynamic";

/**
 * Entry dispatcher. First-run (no admin) → setup. Signed-out → login. Otherwise
 * route by role: admins land in the console; coaches/partners go to their
 * (forthcoming) workspace.
 */
export default async function HomePage() {
  if (!(await hasAdmin())) {
    redirect("/setup");
  }
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    redirect("/login");
  }
  if (session.user.system_role === "admin") {
    redirect("/admin");
  }
  redirect("/workspace");
}
