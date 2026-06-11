"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { pathWithBase } from "@/lib/base-path";

// Signed-out hero screens show the large centered wordmark instead, so the
// corner mark would be redundant there.
const HIDDEN_ON = ["/login", "/setup"];

/**
 * The Dewey "D" monogram pinned to the upper-left corner of every page (rendered
 * once in the root layout). Links home, where the dispatcher routes by role.
 * Positioned absolutely within the content wrapper so it sits below the
 * impersonation banner when that's showing, and vertically centers against a
 * 64px (h-16) page header.
 */
export function CornerLogo() {
  const pathname = usePathname(); // base path already stripped by next/navigation
  if (HIDDEN_ON.includes(pathname)) return null;
  return (
    <Link
      href="/"
      aria-label="Dewey home"
      className="absolute top-3.5 left-4 z-40 hover:opacity-80"
    >
      {/* The navy monogram blends into the dark background, so in dark mode it
          sits on a light "puck" for contrast. Light mode is unchanged. */}
      <img
        src={pathWithBase("/logo.png")}
        alt="Dewey"
        style={{ height: 36, width: "auto" }}
        className="dark:bg-white dark:p-1 dark:-m-1 dark:rounded-lg dark:box-content"
      />
    </Link>
  );
}
