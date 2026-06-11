import type { Metadata } from "next";
import { DM_Sans, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { SessionProvider } from "@/components/SessionProvider";
import { ImpersonationBanner } from "@/components/ImpersonationBanner";
import { CornerLogo } from "@/components/CornerLogo";
import { getSystemSettings } from "@/lib/settings";

const dmSans = DM_Sans({ subsets: ["latin"], variable: "--font-sans" });
const jetbrainsMono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "Dewey — Coaching for Educational Leadership",
  description:
    "Dewey pairs school and district leaders with a human coach, supported by an AI companion.",
};

// Read the admin default theme so the no-flash script can fall back to it for
// users who haven't chosen one. Best-effort — never block rendering on the DB.
async function getDefaultTheme(): Promise<string> {
  try {
    return (await getSystemSettings()).default_theme || "light";
  } catch {
    return "light";
  }
}

// Applies the theme before first paint: the user's saved choice wins, else the
// admin default embedded on <html>. Kept tiny and dependency-free.
const THEME_BOOTSTRAP = `(function(){try{var t=localStorage.getItem('dewey-theme')||document.documentElement.getAttribute('data-default-theme')||'light';if(t==='dark')document.documentElement.classList.add('dark');}catch(e){}})();`;

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const defaultTheme = await getDefaultTheme();
  return (
    <html
      lang="en"
      suppressHydrationWarning
      data-default-theme={defaultTheme}
      className={`${dmSans.variable} ${jetbrainsMono.variable}`}
    >
      <body className="min-h-screen antialiased font-sans bg-dewey-cream text-dewey-ink">
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
        <SessionProvider>
          <ImpersonationBanner />
          <div className="relative">
            <CornerLogo />
            {children}
          </div>
        </SessionProvider>
      </body>
    </html>
  );
}
