import type { Metadata } from "next";
import { DM_Sans, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { SessionProvider } from "@/components/SessionProvider";
import { DialogProvider } from "@/components/DialogProvider";
import { ImpersonationBanner } from "@/components/ImpersonationBanner";
import { CornerLogo } from "@/components/CornerLogo";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getSystemSettings } from "@/lib/settings";
import { getUserById } from "@/lib/db";

const dmSans = DM_Sans({ subsets: ["latin"], variable: "--font-sans" });
const jetbrainsMono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "Dewey — Coaching for Educators and Leaders",
  description:
    "Dewey pairs educators and school and district leaders with a human coach, supported by an AI companion.",
};

/**
 * Resolve the active theme server-side so the initial HTML carries the right
 * `dark` class (no flash) and it follows the user across devices/logins: the
 * user's saved preference wins, otherwise the admin default. Best-effort — any
 * DB error falls back to light.
 */
async function resolveTheme(): Promise<"light" | "dark"> {
  let theme: "light" | "dark" = "light";
  try {
    const def = (await getSystemSettings()).default_theme;
    if (def === "dark") theme = "dark";
  } catch {
    /* ignore */
  }
  try {
    const session = await getServerSession(authOptions);
    if (session?.user?.id) {
      const u = await getUserById(Number(session.user.id));
      const t = u?.settings?.theme;
      if (t === "light" || t === "dark") theme = t;
    }
  } catch {
    /* ignore */
  }
  return theme;
}

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const theme = await resolveTheme();
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${dmSans.variable} ${jetbrainsMono.variable}${theme === "dark" ? " dark" : ""}`}
    >
      <body className="min-h-screen antialiased font-sans bg-dewey-cream text-dewey-ink">
        <SessionProvider>
          <DialogProvider>
            <ImpersonationBanner />
            <div className="relative">
              <CornerLogo />
              {children}
            </div>
          </DialogProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
