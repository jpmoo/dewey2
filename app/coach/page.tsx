import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { RolePlaceholder } from "@/components/RolePlaceholder";

export const dynamic = "force-dynamic";

/**
 * Placeholder home for coach accounts. The coach interface — plan builder,
 * partner roster, message center, phase-exit reviews — is built in later phases.
 */
export default async function CoachPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect("/login");
  // Admins (not impersonating) belong in the console.
  if (session.user.system_role === "admin") redirect("/admin");

  return (
    <RolePlaceholder
      role="Coach"
      name={session.user.nickname || session.user.name || session.user.username}
      heading="Coach workspace"
      blurb="Your plan builder, partner roster, and message center will live here. For now this confirms your coach account is set up and routing correctly."
    />
  );
}
