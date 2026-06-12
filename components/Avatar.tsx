"use client";

import { useEffect, useState } from "react";
import { pathWithBase } from "@/lib/base-path";

/**
 * Circular profile photo for a user, with an initials fallback when they have no
 * avatar (or it fails to load). Pass `version` to cache-bust after an update.
 */
export function Avatar({
  userId,
  name,
  size = 28,
  version,
}: {
  userId: number | null | undefined;
  name?: string | null;
  size?: number;
  version?: number | string;
}) {
  const [failed, setFailed] = useState(false);

  // Retry loading when the user or version changes.
  useEffect(() => setFailed(false), [userId, version]);

  const initials =
    (name ?? "")
      .trim()
      .split(/\s+/)
      .map((s) => s[0])
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?";

  const src =
    userId != null
      ? pathWithBase(`/api/avatars/${userId}${version != null ? `?v=${version}` : ""}`)
      : null;

  if (!src || failed) {
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center rounded-full bg-dewey-surface-2 font-medium text-dewey-mute"
        style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
        aria-hidden
      >
        {initials}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={name ?? "avatar"}
      className="shrink-0 rounded-full object-cover"
      style={{ width: size, height: size }}
      onError={() => setFailed(true)}
    />
  );
}
