import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { RolePlaceholder } from "@/components/RolePlaceholder";

export const dynamic = "force-dynamic";

/**
 * Placeholder home for partner accounts. The partner interface — current arc,
 * activities, and AI companion conversations — is built in later phases.
 */
export default async function PartnerPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect("/login");
  if (session.user.system_role === "admin") redirect("/admin");

  return (
    <RolePlaceholder
      role="Partner"
      name={session.user.nickname || session.user.name || session.user.username}
      heading="Partner workspace"
      blurb="Your coaching arc, activities, and AI companion will live here. For now this confirms your partner account is set up and routing correctly."
    />
  );
}
