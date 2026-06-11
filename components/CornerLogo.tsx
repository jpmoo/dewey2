import Link from "next/link";
import { pathWithBase } from "@/lib/base-path";

/**
 * The Dewey "D" monogram pinned to the upper-left corner of every page (rendered
 * once in the root layout). Links home, where the dispatcher routes by role.
 * Positioned absolutely within the content wrapper so it sits below the
 * impersonation banner when that's showing.
 */
export function CornerLogo() {
  return (
    <Link
      href="/"
      aria-label="Dewey home"
      className="absolute top-3 left-4 z-40 hover:opacity-80"
    >
      <img src={pathWithBase("/logo.png")} alt="Dewey" style={{ height: 44, width: "auto" }} />
    </Link>
  );
}
