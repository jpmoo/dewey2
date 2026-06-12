"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api-client";

type Profile = {
  username: string;
  full_name: string;
  nickname: string | null;
  email: string | null;
  role: string | null;
  about: string | null;
};

/**
 * "Profile" button + modal in the top bar. Lets a user edit their own name,
 * nickname, and description. Username and org assignment are admin-managed and
 * shown read-only. A home for future personal settings (notifications, etc.).
 */
export function ProfileButton({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={className}
        onClick={() => setOpen(true)}
        title="Profile & settings"
      >
        ⚙ Profile
      </button>
      {open && <ProfileModal onClose={() => setOpen(false)} />}
    </>
  );
}

function ProfileModal({ onClose }: { onClose: () => void }) {
  const { update } = useSession();
  const router = useRouter();

  const [profile, setProfile] = useState<Profile | null>(null);
  const [fullName, setFullName] = useState("");
  const [nickname, setNickname] = useState("");
  const [about, setAbout] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ profile: Profile }>("/api/me/profile")
      .then((d) => {
        if (cancelled) return;
        setProfile(d.profile);
        setFullName(d.profile.full_name);
        setNickname(d.profile.nickname ?? "");
        setAbout(d.profile.about ?? "");
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : "Failed to load profile");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async () => {
    if (!fullName.trim()) {
      setErr("Name can't be empty.");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      await apiFetch("/api/me/profile", {
        method: "PATCH",
        body: { full_name: fullName, nickname, about },
      });
      // Refresh the session token so the header name updates without re-login.
      await update({ action: "refresh" });
      router.refresh();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to save");
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg bg-dewey-surface p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-4 text-lg font-semibold">Profile</h3>

        {loading ? (
          <p className="text-sm text-dewey-mute">Loading…</p>
        ) : (
          <div className="space-y-4">
            {err && <p className="text-sm text-red-600">{err}</p>}

            <div>
              <label className="dewey-label">Name</label>
              <input
                className="dewey-input"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
              />
            </div>
            <div>
              <label className="dewey-label">Nickname</label>
              <input
                className="dewey-input"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                placeholder="What you'd like to be called"
              />
            </div>
            <div>
              <label className="dewey-label">Description</label>
              <textarea
                className="dewey-input min-h-[90px]"
                value={about}
                onChange={(e) => setAbout(e.target.value)}
                placeholder="A short description about you and your coaching context."
              />
            </div>

            {/* Read-only context — managed by an admin. */}
            <div className="rounded-md border border-dewey-border bg-dewey-surface-2 p-3 text-xs text-dewey-mute">
              <div>
                <span className="font-medium text-dewey-ink">Username:</span> @{profile?.username}
              </div>
              {profile?.role && (
                <div className="mt-0.5">
                  <span className="font-medium text-dewey-ink">Title:</span> {profile.role}
                </div>
              )}
              <p className="mt-1">Username and school assignment are managed by your administrator.</p>
            </div>
          </div>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className="dewey-btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="dewey-btn-primary w-auto"
            onClick={save}
            disabled={saving || loading}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
