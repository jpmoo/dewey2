import { pathWithBase } from "@/lib/base-path";

/**
 * The Dewey "D" monogram mark, from 1.0's brand assets. Served from /public,
 * so the src is base-path aware for sub-path deployments. Height-driven with
 * auto width so the aspect ratio is preserved at any size.
 */
export function Logo({ size = 40, className }: { size?: number; className?: string }) {
  return (
    <img
      src={pathWithBase("/logo.png")}
      alt="Dewey"
      style={{ height: size, width: "auto" }}
      className={className}
    />
  );
}
