"use client";

import { useEffect, useRef } from "react";
import { Avatar } from "@/components/Avatar";

const ROLE_LABEL: Record<string, string> = {
  admin: "Admin",
  coach: "Coach",
  partner: "Partner",
  site_leader: "Site Leader",
  deputy_site_leader: "Deputy Site Leader",
  district_leader: "District Leader",
};

export type MemberInfo = {
  id: number;
  full_name: string;
  nickname: string | null;
  system_role: string;
  title?: string | null;
  location?: string | null;
};

/**
 * A small pop-up about a chat member, opened from their avatar or name: name,
 * nickname, role and title, where they work, and whether they lead this
 * conversation (the coach, or a community's Chair). Closes on a click outside
 * its row, or Escape.
 */
export function MemberCard({
  member,
  leadLabel,
  alignRight,
  onClose,
}: {
  member: MemberInfo;
  /** "Coach" or "Chair" when this member leads the conversation. */
  leadLabel: string | null;
  alignRight: boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Clicks in the row holding the card (the avatar and name that toggle it)
    // are left to that toggle; anything else closes it.
    const onDown = (e: MouseEvent) => {
      const row = ref.current?.parentElement;
      if (row && !row.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const role = ROLE_LABEL[member.system_role] ?? member.system_role;
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={`About ${member.full_name}`}
      className={`absolute top-full z-30 mt-1 w-64 rounded-lg border border-dewey-border bg-dewey-surface p-3 text-left text-sm shadow-lg ${
        alignRight ? "right-0" : "left-0"
      }`}
    >
      <div className="flex items-center gap-2.5">
        <Avatar userId={member.id} name={member.full_name} size={40} />
        <div className="min-w-0">
          <div className="truncate font-semibold text-dewey-ink">{member.full_name}</div>
          {member.nickname && member.nickname !== member.full_name && (
            <div className="truncate text-xs text-dewey-mute">Goes by {member.nickname}</div>
          )}
        </div>
      </div>
      {leadLabel && (
        <div className="mt-2 inline-flex items-center gap-1 rounded-full bg-dewey-accent/10 px-2 py-0.5 text-[11px] font-medium text-dewey-accent">
          ⚡️ {leadLabel} of this {leadLabel === "Chair" ? "community" : "conversation"}
        </div>
      )}
      <dl className="mt-2 space-y-1 text-xs">
        <div className="flex gap-2">
          <dt className="w-16 shrink-0 text-dewey-mute">Role</dt>
          <dd className="text-dewey-ink">
            {role}
            {member.title ? ` · ${member.title}` : ""}
          </dd>
        </div>
        {member.location && (
          <div className="flex gap-2">
            <dt className="w-16 shrink-0 text-dewey-mute">Location</dt>
            <dd className="text-dewey-ink">{member.location}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}
