import { SignOutButton } from "@/components/SignOutButton";
import { ThemeToggle } from "@/components/ThemeToggle";

/**
 * Shared shell for the not-yet-built coach/partner interfaces. Confirms auth +
 * role routing work end to end and gives each role a distinct landing.
 */
export function RolePlaceholder({
  role,
  name,
  heading,
  blurb,
}: {
  role: string;
  name: string;
  heading: string;
  blurb: string;
}) {
  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="max-w-md w-full rounded-xl border border-dewey-border bg-dewey-surface/60 p-8 text-center">
        <p className="text-xs text-dewey-mute uppercase tracking-wide mb-2">{role}</p>
        <h1 className="text-2xl font-semibold mb-2">{heading}</h1>
        <p className="text-dewey-mute text-sm mb-1">Welcome, {name}.</p>
        <p className="text-dewey-mute text-sm mb-6 text-balance">{blurb}</p>
        <div className="flex items-center justify-center gap-4">
          <ThemeToggle className="text-sm text-dewey-mute hover:text-dewey-ink" />
          <SignOutButton className="text-sm text-dewey-accent hover:underline" />
        </div>
      </div>
    </main>
  );
}
