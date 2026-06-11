import type { Metadata } from "next";
import { DM_Sans, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { SessionProvider } from "@/components/SessionProvider";
import { ImpersonationBanner } from "@/components/ImpersonationBanner";

const dmSans = DM_Sans({ subsets: ["latin"], variable: "--font-sans" });
const jetbrainsMono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "Dewey — Coaching for Educational Leadership",
  description:
    "Dewey pairs school and district leaders with a human coach, supported by an AI companion.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${dmSans.variable} ${jetbrainsMono.variable}`}>
      <body className="min-h-screen antialiased font-sans bg-dewey-cream text-dewey-ink">
        <SessionProvider>
          <ImpersonationBanner />
          {children}
        </SessionProvider>
      </body>
    </html>
  );
}
