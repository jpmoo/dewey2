"use client";

import { useState } from "react";
import { signOut, useSession } from "next-auth/react";
import { apiFetch } from "@/lib/api-client";
import { rootPath } from "@/lib/base-path";

/**
 * Self sign-up after a first Google sign-in. Name and nickname arrive prefilled
 * from Google. Schools are multi-select; "District-wide" clears and disables
 * them, and the server saves every school in the district.
 */
export function WelcomeForm({
  email,
  defaultName,
  defaultNickname,
  districtName,
  schools,
}: {
  email: string;
  defaultName: string;
  defaultNickname: string;
  districtName: string | null;
  schools: { id: number; name: string }[];
}) {
  const { update } = useSession();
  const [fullName, setFullName] = useState(defaultName);
  const [nickname, setNickname] = useState(defaultNickname);
  const [title, setTitle] = useState("");
  const [schoolIds, setSchoolIds] = useState<number[]>([]);
  const [districtWide, setDistrictWide] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  function toggleSchool(id: number) {
    setSchoolIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  }

  function toggleDistrictWide(on: boolean) {
    setDistrictWide(on);
    if (on) setSchoolIds([]);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!fullName.trim()) return setError("Please enter your full name.");
    if (schools.length > 0 && !districtWide && schoolIds.length === 0) {
      return setError("Choose your school, or district-wide.");
    }
    setSaving(true);
    try {
      await apiFetch("/api/welcome", {
        method: "POST",
        body: { full_name: fullName, nickname, title, school_ids: schoolIds, district_wide: districtWide },
      });
      // Swap the session over to the new account, then let the dispatcher route it.
      await update({ action: "complete-signup" });
      window.location.href = rootPath;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-xl border border-dewey-border bg-dewey-surface/60 p-6 text-left space-y-4"
    >
      {error && <p className="text-sm text-red-600">{error}</p>}
      <p className="text-xs text-dewey-mute">
        Signed in with Google as <span className="font-medium text-dewey-ink">{email}</span>
      </p>
      <div>
        <label htmlFor="full-name" className="dewey-label">Full name</label>
        <input
          id="full-name"
          className="dewey-input"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          required
          autoComplete="name"
        />
      </div>
      <div>
        <label htmlFor="nickname" className="dewey-label">Nickname</label>
        <input
          id="nickname"
          className="dewey-input"
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          placeholder="What should we call you?"
          autoComplete="nickname"
        />
      </div>
      <div>
        <label htmlFor="title" className="dewey-label">Title</label>
        <input
          id="title"
          className="dewey-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Assistant Principal"
          autoComplete="organization-title"
        />
      </div>
      {schools.length > 0 && (
        <fieldset>
          <legend className="dewey-label">
            School{districtName ? <span className="font-normal text-dewey-mute"> · {districtName}</span> : null}
          </legend>
          <label className="mb-2 flex items-center gap-2 text-sm font-medium text-dewey-ink">
            <input type="checkbox" checked={districtWide} onChange={(e) => toggleDistrictWide(e.target.checked)} />
            District-wide
          </label>
          <div
            className={`max-h-56 space-y-1 overflow-y-auto rounded-md border border-dewey-border bg-dewey-surface p-2 ${
              districtWide ? "opacity-50" : ""
            }`}
          >
            {schools.map((s) => (
              <label key={s.id} className="flex items-center gap-2 text-sm text-dewey-ink">
                <input
                  type="checkbox"
                  disabled={districtWide}
                  checked={schoolIds.includes(s.id)}
                  onChange={() => toggleSchool(s.id)}
                />
                {s.name}
              </label>
            ))}
          </div>
          <p className="mt-1 text-xs text-dewey-mute">Choose every school you work in.</p>
        </fieldset>
      )}
      <button type="submit" disabled={saving} className="dewey-btn-primary">
        {saving ? "Setting up…" : "Continue"}
      </button>
      <button
        type="button"
        onClick={() => signOut({ callbackUrl: rootPath })}
        className="w-full text-center text-sm text-dewey-mute underline-offset-2 hover:underline"
      >
        Not you? Sign out
      </button>
    </form>
  );
}
