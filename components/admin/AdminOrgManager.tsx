"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api-client";
import { useDialog } from "@/components/DialogProvider";

type School = { id: number; district_id: number; name: string };
type DistrictWithSchools = { id: number; name: string; schools: School[] };

export function AdminOrgManager() {
  const dialog = useDialog();
  const [districts, setDistricts] = useState<DistrictWithSchools[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newDistrict, setNewDistrict] = useState("");
  const [schoolDrafts, setSchoolDrafts] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const { districts } = await apiFetch<{ districts: DistrictWithSchools[] }>(
        "/api/admin/districts"
      );
      setDistricts(districts);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load organization");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const addDistrict = useCallback(async () => {
    if (!newDistrict.trim()) return;
    setBusy(true);
    try {
      await apiFetch("/api/admin/districts", { method: "POST", body: { name: newDistrict } });
      setNewDistrict("");
      await load();
    } catch (e) {
      dialog.alert(e instanceof Error ? e.message : "Failed to add district");
    } finally {
      setBusy(false);
    }
  }, [newDistrict, load, dialog]);

  const addSchool = useCallback(
    async (districtId: number) => {
      const name = (schoolDrafts[districtId] ?? "").trim();
      if (!name) return;
      setBusy(true);
      try {
        await apiFetch("/api/admin/schools", {
          method: "POST",
          body: { district_id: districtId, name },
        });
        setSchoolDrafts((prev) => ({ ...prev, [districtId]: "" }));
        await load();
      } catch (e) {
        dialog.alert(e instanceof Error ? e.message : "Failed to add school");
      } finally {
        setBusy(false);
      }
    },
    [schoolDrafts, load, dialog]
  );

  const removeDistrict = useCallback(
    async (d: DistrictWithSchools) => {
      if (
        !(await dialog.confirm(
          `Hide "${d.name}"? It will be removed from view but recoverable from the audit log.`,
          { title: "Hide district", confirmText: "Hide" }
        ))
      )
        return;
      setBusy(true);
      try {
        await apiFetch(`/api/admin/districts/${d.id}`, { method: "DELETE" });
        await load();
      } catch (e) {
        dialog.alert(e instanceof Error ? e.message : "Failed to delete district");
      } finally {
        setBusy(false);
      }
    },
    [load, dialog]
  );

  const removeSchool = useCallback(
    async (s: School) => {
      if (
        !(await dialog.confirm(
          `Hide "${s.name}"? It will be removed from view but recoverable from the audit log.`,
          { title: "Hide school", confirmText: "Hide" }
        ))
      )
        return;
      setBusy(true);
      try {
        await apiFetch(`/api/admin/schools/${s.id}`, { method: "DELETE" });
        await load();
      } catch (e) {
        dialog.alert(e instanceof Error ? e.message : "Failed to delete school");
      } finally {
        setBusy(false);
      }
    },
    [load, dialog]
  );

  return (
    <section>
      <div className="mb-4">
        <h2 className="text-lg font-semibold">Organization</h2>
        <p className="text-sm text-dewey-mute">
          Districts and the schools within them. Accounts are assigned to a
          district and school in user management.
        </p>
      </div>

      {loading ? (
        <p className="text-dewey-mute">Loading organization…</p>
      ) : error ? (
        <p className="text-red-600">{error}</p>
      ) : (
        <div className="space-y-4">
          {districts.map((d) => (
            <div key={d.id} className="rounded-lg border border-dewey-border bg-dewey-surface p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-medium">{d.name}</h3>
                <button
                  type="button"
                  className="text-xs text-red-700 hover:underline disabled:opacity-50"
                  onClick={() => removeDistrict(d)}
                  disabled={busy}
                >
                  Delete district
                </button>
              </div>
              <ul className="space-y-1 mb-3">
                {d.schools.length === 0 ? (
                  <li className="text-sm text-dewey-mute">No schools yet.</li>
                ) : (
                  d.schools.map((s) => (
                    <li
                      key={s.id}
                      className="flex items-center justify-between text-sm px-2 py-1 rounded hover:bg-dewey-surface-2"
                    >
                      <span>{s.name}</span>
                      <button
                        type="button"
                        className="text-xs text-red-700 hover:underline disabled:opacity-50"
                        onClick={() => removeSchool(s)}
                        disabled={busy}
                      >
                        Remove
                      </button>
                    </li>
                  ))
                )}
              </ul>
              <div className="flex gap-2">
                <input
                  className="dewey-input"
                  placeholder="Add a school…"
                  value={schoolDrafts[d.id] ?? ""}
                  onChange={(e) =>
                    setSchoolDrafts((prev) => ({ ...prev, [d.id]: e.target.value }))
                  }
                  onKeyDown={(e) => e.key === "Enter" && addSchool(d.id)}
                />
                <button
                  type="button"
                  className="dewey-btn-secondary"
                  onClick={() => addSchool(d.id)}
                  disabled={busy || !(schoolDrafts[d.id] ?? "").trim()}
                >
                  Add
                </button>
              </div>
            </div>
          ))}

          <div className="flex gap-2">
            <input
              className="dewey-input"
              placeholder="New district name…"
              value={newDistrict}
              onChange={(e) => setNewDistrict(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addDistrict()}
            />
            <button
              type="button"
              className="dewey-btn-secondary"
              onClick={addDistrict}
              disabled={busy || !newDistrict.trim()}
            >
              Add district
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
