"use client";

import { pathWithBase } from "@/lib/base-path";

/**
 * A RAG citation chip. When the source has a path (an in-house document URL) it's
 * a live link that opens the document in a new tab; otherwise it's a plain label.
 */
export function SourcePill({ name, path }: { name: string; path?: string }) {
  const cls =
    "inline-block max-w-[180px] truncate rounded-full border px-2 py-0.5 text-[11px]";
  if (path) {
    const href = /^https?:\/\//.test(path) ? path : pathWithBase(path);
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        title={`Open ${name}`}
        className={`${cls} border-dewey-accent/40 bg-dewey-accent/5 text-dewey-accent hover:bg-dewey-accent/10 hover:underline`}
      >
        {name}
      </a>
    );
  }
  return (
    <span title={name} className={`${cls} border-dewey-border bg-dewey-surface-2 text-dewey-mute`}>
      {name}
    </span>
  );
}
