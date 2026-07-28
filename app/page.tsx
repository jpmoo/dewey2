import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { hasAdmin } from "@/lib/db";

// Reads the DB and the session on every request — never prerender.
export const dynamic = "force-dynamic";

/**
 * Entry dispatcher. First-run (no admin) → setup. Signed-out → login. Otherwise
 * route by role: admins land in the console; coaches and partners go to their
 * own workspaces. Drives impersonation too — after an admin starts/stops
 * impersonating, a redirect through "/" lands on the right place for the
 * now-current role.
 */
export default async function HomePage() {
  if (!(await hasAdmin())) {
    redirect("/setup");
  }
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    redirect("/login");
  }
  switch (session.user.system_role) {
    case "admin":
      redirect("/admin");
    case "coach":
      redirect("/coach");
    case "site_leader":
    case "deputy_site_leader":
      redirect("/leader");
    default:
      redirect("/partner");
  }
}
