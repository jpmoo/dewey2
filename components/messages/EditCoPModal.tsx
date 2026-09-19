"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api-client";

type Participant = { id: number; full_name: string; nickname?: string | null; system_role: string };

/** Edit a Community of Practice: rename, revise the goal, and reassign the Chair. */
export function EditCoPModal({
  threadId,
  initialSubject,
  initialGoal,
  initialChairId,
  participants,
  onClose,
  onSaved,
}: {
  threadId: number;
  initialSubject: string;
  initialGoal: string;
  initialChairId: number | null;
  participants: Participant[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [subject, setSubject] = useState(initialSubject);
  const [goal, setGoal] = useState(initialGoal);
  const [chairId, setChairId] = useState<number | null>(initialChairId);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setErr(null);
    if (!subject.trim()) return setErr("Give the community a name.");
    if (!goal.trim()) return setErr("The goal can't be empty.");
    if (chairId == null) return setErr("Choose a Chair.");
    setSaving(true);
    try {
      await apiFetch(`/api/cops/${threadId}`, {
        method: "PATCH",
        body: { subject, goal, chairId },
      });
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to save");
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/40 p-4" onClick={onClose}>
      <div className="my-8 w-full max-w-lg rounded-lg border border-dewey-border bg-dewey-surface p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-semibold text-dewey-ink">Edit community</h3>
          <button type="button" className="text-dewey-mute hover:text-dewey-ink" onClick={onClose}>✕</button>
        </div>
        <div className="space-y-4">
          <div>
            <label className="dewey-label">Name</label>
            <input className="dewey-input" value={subject} onChange={(e) => setSubject(e.target.value)} />
          </div>
          <div>
            <label className="dewey-label">Goal / problem of practice</label>
            <textarea className="dewey-input min-h-[70px]" value={goal} onChange={(e) => setGoal(e.target.value)} />
          </div>
          <div>
            <label className="dewey-label">Chair</label>
            <select className="dewey-input" value={chairId ?? ""} onChange={(e) => setChairId(Number(e.target.value) || null)}>
              <option value="">Choose a Chair…</option>
              {participants.map((p) => (
                <option key={p.id} value={p.id}>{p.nickname || p.full_name}</option>
              ))}
            </select>
            <p className="mt-1 text-xs text-dewey-mute">The Chair leads the arc and advances the community. Must be a member.</p>
          </div>
          {err && <p className="text-sm text-red-600">{err}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className="dewey-btn-secondary px-5 py-2.5" onClick={onClose} disabled={saving}>Cancel</button>
            <button type="button" className="dewey-btn-primary w-auto" onClick={save} disabled={saving}>
              <span aria-hidden>💾</span> {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
