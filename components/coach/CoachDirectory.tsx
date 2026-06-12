"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api-client";

type Partner = {
  id: number;
  username: string;
  full_name: string;
  nickname: string | null;
  email: string | null;
  role: string | null;
  about: string | null;
  district_id: number | null;
  school_id: number | null;
  school_ids: number[];
  district_name: string | null;
  school_names: string[];
  created_at: string;
};

type School = { id: number; district_id: number; name: string };
type Directory = {
  partners: Partner[];
  schools: School[];
  scope: "school" | "district" | "none";
};

/**
 * Partner directory for a coach: partners in their school, or — for a
 * district-wide coach — across the district (with a school filter). Clicking a
 * partner opens an info modal that also shows the coach's history with them.
 */
export function CoachDirectory() {
  const [data, setData] = useState<Directory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Partner | null>(null);

  const [query, setQuery] = useState("");
  // "all" = any; "districtwide" = assigned to district, no school.
  const [filterSchool, setFilterSchool] = useState<"all" | "districtwide" | number>("all");

  const load = useCallback(async () => {
    try {
      const d = await apiFetch<Directory>("/api/coach/partners");
      setData(d);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load partners");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const partners = data?.partners ?? [];
  const districtWide = data?.scope === "district";

  const q = query.trim().toLowerCase();
  const filtered = partners.filter((p) => {
    if (districtWide) {
      if (filterSchool === "districtwide") {
        if (p.school_ids.length > 0) return false;
      } else if (typeof filterSchool === "number" && !p.school_ids.includes(filterSchool)) {
        return false;
      }
    }
    if (q) {
      const hay = [p.full_name, p.username, p.email, p.nickname, p.role]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const filtersActive = q !== "" || filterSchool !== "all";

  return (
    <section>
      <div className="mb-4">
        <h2 className="text-lg font-semibold">Partner Directory</h2>
        <p className="text-sm text-dewey-mute">
          {data?.scope === "district"
            ? "Partners across your district."
            : data?.scope === "school"
            ? "Partners in your school."
            : "Your account isn't assigned to a district yet."}
        </p>
      </div>

      {loading ? (
        <p className="text-dewey-mute">Loading partners…</p>
      ) : error ? (
        <p className="text-red-600">{error}</p>
      ) : (
        <>
          <div className="mb-4 space-y-2">
            <input
              type="search"
              className="dewey-input"
              placeholder="Search by name, username, email, or title…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {districtWide && (data?.schools.length ?? 0) > 0 && (
              <select
                className="dewey-input"
                value={typeof filterSchool === "number" ? String(filterSchool) : filterSchool}
                onChange={(e) => {
                  const v = e.target.value;
                  setFilterSchool(v === "all" || v === "districtwide" ? v : Number(v));
                }}
              >
                <option value="all">All schools</option>
                <option value="districtwide">District-wide (no school)</option>
                {data?.schools.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            )}
            <div className="flex items-center justify-between text-xs text-dewey-mute">
              <span>
                {filtered.length} of {partners.length} partner{partners.length === 1 ? "" : "s"}
              </span>
              {filtersActive && (
                <button
                  type="button"
                  className="text-dewey-accent hover:underline"
                  onClick={() => {
                    setQuery("");
                    setFilterSchool("all");
                  }}
                >
                  Clear filters
                </button>
              )}
            </div>
          </div>

          {filtered.length === 0 ? (
            <p className="py-4 text-center text-sm text-dewey-mute">
              {partners.length === 0
                ? "No partners in your directory yet."
                : "No partners match these filters."}
            </p>
          ) : (
            <ul className="space-y-2">
              {filtered.map((p) => (
                <li
                  key={p.id}
                  className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-dewey-border bg-dewey-surface p-3 hover:bg-dewey-surface-2"
                  onClick={() => setSelected(p)}
                >
                  <div className="min-w-0">
                    <div>
                      <span className="font-medium">{p.full_name}</span>
                      <span className="ml-2 text-sm text-dewey-mute">@{p.username}</span>
                      {p.role && <span className="ml-2 text-xs text-dewey-mute">· {p.role}</span>}
                    </div>
                    <div className="truncate text-xs text-dewey-mute">
                      {p.school_names.length > 0
                        ? `${p.district_name} · ${p.school_names.join(", ")}`
                        : `${p.district_name ?? "Unassigned"} · District-wide`}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {selected && <PartnerModal partner={selected} onClose={() => setSelected(null)} />}
    </section>
  );
}

function PartnerModal({ partner, onClose }: { partner: Partner; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg bg-dewey-surface p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4">
          <h3 className="text-lg font-semibold">{partner.full_name}</h3>
          <p className="text-sm text-dewey-mute">
            @{partner.username}
            {partner.role ? ` · ${partner.role}` : ""}
          </p>
        </div>

        <dl className="space-y-2 text-sm">
          <Row label="Email">{partner.email || "—"}</Row>
          <Row label="Nickname">{partner.nickname || "—"}</Row>
          <Row label="District">{partner.district_name || "—"}</Row>
          <Row label="Buildings">
            {partner.school_names.length > 0 ? partner.school_names.join(", ") : "District-wide"}
          </Row>
          {partner.about && (
            <div>
              <dt className="text-dewey-mute">Coaching context</dt>
              <dd className="mt-0.5 whitespace-pre-wrap">{partner.about}</dd>
            </div>
          )}
        </dl>

        <div className="mt-5">
          <h4 className="text-sm font-medium text-dewey-ink">Your history with this partner</h4>
          <p className="mt-1 text-xs text-dewey-mute">
            No coaching history yet. Once partnerships are live, the arcs and activities you&apos;ve
            run with this partner will appear here.
          </p>
        </div>

        <div className="mt-6 flex justify-end">
          <button type="button" className="dewey-btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-dewey-mute">{label}</dt>
      <dd className="text-right text-dewey-ink">{children}</dd>
    </div>
  );
}
