import { pathWithBase } from "@/lib/base-path";

/**
 * The Dewey mark (apple with glasses + mustache), carried over from 1.0.
 * Served from /public, so the src is base-path aware for sub-path deployments.
 */
export function Logo({ size = 40, className }: { size?: number; className?: string }) {
  return (
    <img
      src={pathWithBase("/logo.svg")}
      width={size}
      height={size}
      alt="Dewey"
      className={className}
    />
  );
}
