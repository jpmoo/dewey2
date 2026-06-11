import { pathWithBase } from "@/lib/base-path";

/**
 * The Dewey wordmark — the brand logo. Served from /public, so the src is
 * base-path aware for sub-path deployments. Height-driven with auto width so
 * the wordmark keeps its aspect ratio at any size.
 */
export function Logo({ size = 40, className }: { size?: number; className?: string }) {
  return (
    <img
      src={pathWithBase("/wordmark.png")}
      alt="Dewey"
      style={{ height: size, width: "auto" }}
      className={className}
    />
  );
}
