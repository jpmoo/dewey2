"use client";

import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api-client";

type Recipient = {
  id: number;
  full_name: string;
  username: string;
  system_role: string;
  district_name: string | null;
  school_names: string[];
};
type School = { id: number; name: string };
type District = { id: number; name: string; schools: School[] };

/**
 * Create a Community of Practice: name it, add members, anchor it to a school or
 * district, state the goal, and pick the Chair (any member). Chair replaces the
 * coach for the community's arc.
 */
export function CreateCoPModal({
  meId,
  onClose,
  onCreated,
}: {
  meId: number;
  onClose: () => void;
  onCreated: (threadId: number) => void;
}) {
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [districts, setDistricts] = useState<District[]>([]);
  const [selected, setSelected] = useState<Recipient[]>([]);
  const [query, setQuery] = useState("");
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [chairId, setChairId] = useState<number>(meId);
  const [anchorLevel, setAnchorLevel] = useState<"district" | "school">("district");
  const [districtId, setDistrictId] = useState<number | null>(null);
  const [schoolId, setSchoolId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      apiFetch<{ recipients: Recipient[] }>("/api/messages/recipients").catch(() => ({ recipients: [] })),
      apiFetch<{ districts: District[] }>("/api/cops/anchors").catch(() => ({ districts: [] })),
    ])
      .then(([r, a]) => {
        setRecipients(r.recipients);
        setDistricts(a.districts);
        if (a.districts.length === 1) setDistrictId(a.districts[0].id);
      })
      .finally(() => setLoading(false));
  }, []);

  const q = query.trim().toLowerCase();
  const selectedIds = new Set(selected.map((r) => r.id));
  const matches = recipients
    .filter((r) => !selectedIds.has(r.id))
    .filter((r) => !q || r.full_name.toLowerCase().includes(q) || r.username.toLowerCase().includes(q))
    .slice(0, 8);

  // Chair options: the creator plus every selected member.
  const chairOptions = useMemo(
    () => [{ id: meId, label: "Me" }, ...selected.map((r) => ({ id: r.id, label: r.full_name }))],
    [meId, selected]
  );
  useEffect(() => {
    // Keep the chair valid if a selected member is removed.
    if (!chairOptions.some((o) => o.id === chairId)) setChairId(meId);
  }, [chairOptions, chairId, meId]);

  const schoolsForDistrict = districts.find((d) => d.id === districtId)?.schools ?? [];

  const submit = async () => {
    setErr(null);
    if (!name.trim()) return setErr("Give the community a name.");
    if (!goal.trim()) return setErr("State the community's goal or problem of practice.");
    if (selected.length < 2) return setErr("Add at least two other members (a CoP is more than two people).");
    if (anchorLevel === "district" && !districtId) return setErr("Choose a district to anchor to.");
    if (anchorLevel === "school" && !schoolId) return setErr("Choose a school to anchor to.");
    setSaving(true);
    try {
      const { threadId } = await apiFetch<{ threadId: number }>("/api/cops", {
        method: "POST",
        body: {
          subject: name,
          goal,
          chairId,
          memberIds: selected.map((r) => r.id),
          anchorLevel,
          districtId: anchorLevel === "district" ? districtId : null,
          schoolId: anchorLevel === "school" ? schoolId : null,
        },
      });
      onCreated(threadId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to create community");
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/40 p-4" onClick={onClose}>
      <div className="my-8 w-full max-w-xl rounded-lg border border-dewey-border bg-dewey-surface p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-semibold text-dewey-ink">New Community of Practice</h3>
          <button type="button" className="text-dewey-mute hover:text-dewey-ink" onClick={onClose}>✕</button>
        </div>

        {loading ? (
          <p className="text-dewey-mute">Loading…</p>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="dewey-label">Name</label>
              <input className="dewey-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. K-2 Literacy Community" />
            </div>

            <div>
              <label className="dewey-label">Goal / problem of practice</label>
              <textarea className="dewey-input min-h-[70px]" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="What is this community working on together? (Injected as context for @dewey throughout the arc.)" />
            </div>

            <div>
              <label className="dewey-label">Members</label>
              {selected.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {selected.map((r) => (
                    <span key={r.id} className="inline-flex items-center gap-1 rounded-full border border-dewey-accent/40 bg-dewey-accent/5 px-2 py-0.5 text-xs text-dewey-accent">
                      {r.full_name}
                      <button type="button" className="text-dewey-accent/70 hover:text-dewey-accent" onClick={() => setSelected((s) => s.filter((x) => x.id !== r.id))}>✕</button>
                    </span>
                  ))}
                </div>
              )}
              <input className="dewey-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search people to add…" />
              {q && matches.length > 0 && (
                <ul className="mt-1 max-h-44 overflow-auto rounded-md border border-dewey-border">
                  {matches.map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-dewey-surface-2"
                        onClick={() => { setSelected((s) => [...s, r]); setQuery(""); }}
                      >
                        <span>{r.full_name}</span>
                        <span className="text-xs text-dewey-mute">@{r.username} · {r.system_role}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-1 text-xs text-dewey-mute">You’re automatically a member. Add at least two others.</p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="dewey-label">Chair</label>
                <select className="dewey-input" value={chairId} onChange={(e) => setChairId(Number(e.target.value))}>
                  {chairOptions.map((o) => (
                    <option key={o.id} value={o.id}>{o.label}</option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-dewey-mute">Leads the arc and reviews contributions (replaces a coach).</p>
              </div>
              <div>
                <label className="dewey-label">Anchor</label>
                <div className="flex gap-3 text-sm">
                  <label className="flex items-center gap-1">
                    <input type="radio" checked={anchorLevel === "district"} onChange={() => { setAnchorLevel("district"); setSchoolId(null); }} /> District
                  </label>
                  <label className="flex items-center gap-1">
                    <input type="radio" checked={anchorLevel === "school"} onChange={() => setAnchorLevel("school")} /> School
                  </label>
                </div>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="dewey-label">District</label>
                <select className="dewey-input" value={districtId ?? ""} onChange={(e) => { setDistrictId(Number(e.target.value) || null); setSchoolId(null); }}>
                  <option value="">Choose district…</option>
                  {districts.map((d) => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              </div>
              {anchorLevel === "school" && (
                <div>
                  <label className="dewey-label">School</label>
                  <select className="dewey-input" value={schoolId ?? ""} onChange={(e) => setSchoolId(Number(e.target.value) || null)} disabled={!districtId}>
                    <option value="">Choose school…</option>
                    {schoolsForDistrict.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            {err && <p className="text-sm text-red-600">{err}</p>}

            <div className="flex justify-end gap-2">
              <button type="button" className="dewey-btn-secondary px-5 py-2.5" onClick={onClose} disabled={saving}>Cancel</button>
              <button type="button" className="dewey-btn-primary w-auto" onClick={submit} disabled={saving}>
                <span aria-hidden>👥</span> {saving ? "Creating…" : "Create community"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
