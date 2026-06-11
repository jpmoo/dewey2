"use client";

import { useCallback, useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { apiFetch } from "@/lib/api-client";
import { rootPath } from "@/lib/base-path";

type SystemRole = "admin" | "coach" | "partner";

type User = {
  id: number;
  username: string;
  full_name: string;
  nickname: string | null;
  email: string | null;
  system_role: SystemRole;
  district_id: number | null;
  school_id: number | null;
  role: string | null;
  about: string | null;
  settings: Record<string, unknown>;
  created_at: string;
};

type School = { id: number; district_id: number; name: string };
type DistrictWithSchools = { id: number; name: string; schools: School[] };

const ROLE_BADGE: Record<SystemRole, string> = {
  admin: "bg-amber-100 text-amber-800",
  coach: "bg-blue-100 text-blue-800",
  partner: "bg-green-100 text-green-800",
};

const ROLES: SystemRole[] = ["admin", "coach", "partner"];

type UserLogView = {
  id: number;
  action: string;
  detail: string | null;
  created_at: string;
  actor_name: string | null;
};

const ACTION_LABELS: Record<string, string> = {
  created: "Account created",
  updated: "Updated",
  impersonated: "Admin signed in as user",
  signed_in: "Signed in",
};

export function AdminUserManager() {
  const { data: session, update } = useSession();
  const currentUserId = session?.user?.id ? parseInt(session.user.id, 10) : null;

  const [users, setUsers] = useState<User[]>([]);
  const [impersonating, setImpersonating] = useState<number | null>(null);
  const [districts, setDistricts] = useState<DistrictWithSchools[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<User | null>(null);
  const [creating, setCreating] = useState(false);

  // Filters.
  const [query, setQuery] = useState("");
  const [filterDistrict, setFilterDistrict] = useState<number | null>(null);
  // "all" = any school; "districtwide" = assigned to the district but no school.
  const [filterSchool, setFilterSchool] = useState<"all" | "districtwide" | number>("all");
  const [filterRole, setFilterRole] = useState<SystemRole | "all">("all");

  const load = useCallback(async () => {
    try {
      const [{ users }, { districts }] = await Promise.all([
        apiFetch<{ users: User[] }>("/api/admin/users"),
        apiFetch<{ districts: DistrictWithSchools[] }>("/api/admin/districts"),
      ]);
      setUsers(users);
      setDistricts(districts);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load users");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const loginAs = useCallback(
    async (u: User) => {
      if (
        !confirm(
          `Log in as ${u.full_name} (@${u.username})? You'll see Dewey as this ${u.system_role}. A banner lets you return to admin.`
        )
      )
        return;
      setImpersonating(u.id);
      try {
        await update({ action: "impersonate", userId: u.id });
        // Hard navigation so the dispatcher routes by the now-impersonated role.
        window.location.href = rootPath;
      } catch (e) {
        alert(e instanceof Error ? e.message : "Failed to switch users");
        setImpersonating(null);
      }
    },
    [update]
  );

  // Schools shown in the filter are strictly those in the chosen district.
  const schoolOptions =
    filterDistrict !== null
      ? districts.find((d) => d.id === filterDistrict)?.schools ?? []
      : [];

  const q = query.trim().toLowerCase();
  const filtered = users.filter((u) => {
    if (filterRole !== "all" && u.system_role !== filterRole) return false;
    if (filterDistrict !== null && u.district_id !== filterDistrict) return false;
    if (filterSchool === "districtwide") {
      if (u.school_id !== null) return false;
    } else if (typeof filterSchool === "number" && u.school_id !== filterSchool) {
      return false;
    }
    if (q) {
      const hay = [u.full_name, u.username, u.email, u.nickname, u.role]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const filtersActive =
    q !== "" || filterRole !== "all" || filterDistrict !== null || filterSchool !== "all";

  // Resolve a user's district/school to display names from the loaded org tree.
  const orgLabel = (u: User): string => {
    const d = districts.find((x) => x.id === u.district_id);
    if (!d) return "Unassigned";
    const s = d.schools.find((x) => x.id === u.school_id);
    return s ? `${d.name} · ${s.name}` : `${d.name} · District-wide`;
  };

  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Users</h2>
          <p className="text-sm text-dewey-mute">
            Each account has one role: admin, coach, or partner.
          </p>
        </div>
        <button type="button" className="dewey-btn-secondary" onClick={() => setCreating(true)}>
          + New user
        </button>
      </div>

      {loading ? (
        <p className="text-dewey-mute">Loading users…</p>
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
            <div className="grid grid-cols-3 gap-2">
              <select
                className="dewey-input"
                value={filterDistrict ?? ""}
                onChange={(e) => {
                  setFilterDistrict(e.target.value === "" ? null : Number(e.target.value));
                  setFilterSchool("all"); // school list depends on district
                }}
              >
                <option value="">All districts</option>
                {districts.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
              <select
                className="dewey-input"
                value={typeof filterSchool === "number" ? String(filterSchool) : filterSchool}
                disabled={filterDistrict === null}
                title={filterDistrict === null ? "Select a district first" : undefined}
                onChange={(e) => {
                  const v = e.target.value;
                  setFilterSchool(v === "all" || v === "districtwide" ? v : Number(v));
                }}
              >
                <option value="all">All schools</option>
                <option value="districtwide">District-wide (no school)</option>
                {schoolOptions.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
              <select
                className="dewey-input"
                value={filterRole}
                onChange={(e) => setFilterRole(e.target.value as SystemRole | "all")}
              >
                <option value="all">All roles</option>
                {ROLES.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>
            <div className="flex items-center justify-between text-xs text-dewey-mute">
              <span>
                {filtered.length} of {users.length} user{users.length === 1 ? "" : "s"}
              </span>
              {filtersActive && (
                <button
                  type="button"
                  className="text-dewey-accent hover:underline"
                  onClick={() => {
                    setQuery("");
                    setFilterDistrict(null);
                    setFilterSchool("all");
                    setFilterRole("all");
                  }}
                >
                  Clear filters
                </button>
              )}
            </div>
          </div>

          {filtered.length === 0 ? (
            <p className="text-sm text-dewey-mute py-4 text-center">No users match these filters.</p>
          ) : (
            <ul className="space-y-2">
              {filtered.map((u) => (
            <li
              key={u.id}
              className="flex items-center justify-between gap-3 p-3 rounded-lg border border-dewey-border bg-dewey-surface hover:bg-dewey-surface-2 cursor-pointer"
              onClick={() => setEditing(u)}
            >
              <div className="min-w-0">
                <div>
                  <span className="font-medium">{u.full_name}</span>
                  <span className="ml-2 text-sm text-dewey-mute">@{u.username}</span>
                  {u.role && <span className="ml-2 text-xs text-dewey-mute">· {u.role}</span>}
                </div>
                <div className="text-xs text-dewey-mute truncate">{orgLabel(u)}</div>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                {currentUserId !== u.id && (
                  <button
                    type="button"
                    className="text-xs text-dewey-accent hover:underline disabled:opacity-50"
                    onClick={(e) => {
                      e.stopPropagation();
                      loginAs(u);
                    }}
                    disabled={impersonating !== null}
                    title={`View Dewey as ${u.full_name}`}
                  >
                    {impersonating === u.id ? "Switching…" : "Log in as"}
                  </button>
                )}
                <span className={`text-xs px-2 py-0.5 rounded ${ROLE_BADGE[u.system_role]}`}>
                  {u.system_role}
                </span>
              </div>
            </li>
              ))}
            </ul>
          )}
        </>
      )}

      {creating && (
        <UserCreateModal
          districts={districts}
          onClose={() => setCreating(false)}
          onSaved={async () => {
            setCreating(false);
            await load();
          }}
        />
      )}

      {editing && (
        <UserEditModal
          user={editing}
          districts={districts}
          isSelf={currentUserId === editing.id}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
        />
      )}
    </section>
  );
}

// ============================================================
// Shared org pickers
// ============================================================

function OrgPickers({
  districts,
  districtId,
  schoolId,
  onChange,
}: {
  districts: DistrictWithSchools[];
  districtId: number | null;
  schoolId: number | null;
  onChange: (next: { district_id: number | null; school_id: number | null }) => void;
}) {
  const schools = districts.find((d) => d.id === districtId)?.schools ?? [];
  return (
    <div className="grid grid-cols-2 gap-3">
      <div>
        <label className="dewey-label">District</label>
        <select
          className="dewey-input"
          value={districtId ?? ""}
          onChange={(e) => {
            const next = e.target.value === "" ? null : Number(e.target.value);
            // Changing district clears any now-invalid school.
            onChange({ district_id: next, school_id: null });
          }}
        >
          <option value="">— unassigned —</option>
          {districts.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="dewey-label">School</label>
        <select
          className="dewey-input"
          value={schoolId ?? ""}
          disabled={districtId === null}
          onChange={(e) =>
            onChange({
              district_id: districtId,
              school_id: e.target.value === "" ? null : Number(e.target.value),
            })
          }
        >
          <option value="">— unassigned —</option>
          {schools.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

function ModalShell({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-dewey-surface rounded-lg shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold mb-4">{title}</h3>
        {children}
      </div>
    </div>
  );
}

// ============================================================
// Create
// ============================================================

function UserCreateModal({
  districts,
  onClose,
  onSaved,
}: {
  districts: DistrictWithSchools[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [username, setUsername] = useState("");
  const [fullName, setFullName] = useState("");
  const [nickname, setNickname] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [systemRole, setSystemRole] = useState<SystemRole>("partner");
  const [districtId, setDistrictId] = useState<number | null>(null);
  const [schoolId, setSchoolId] = useState<number | null>(null);
  const [role, setRole] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setErr(null);
    if (password.length < 8) {
      setErr("Password must be at least 8 characters.");
      return;
    }
    setSaving(true);
    try {
      await apiFetch("/api/admin/users", {
        method: "POST",
        body: {
          username,
          full_name: fullName,
          nickname,
          email,
          password,
          system_role: systemRole,
          district_id: districtId,
          school_id: schoolId,
          role,
        },
      });
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to create user");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell title="New user" onClose={onClose}>
      <div className="space-y-4">
        {err && <p className="text-sm text-red-600">{err}</p>}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="dewey-label">Username</label>
            <input className="dewey-input" value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <div>
            <label className="dewey-label">Temporary password</label>
            <input
              type="password"
              className="dewey-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
            />
          </div>
        </div>
        <div>
          <label className="dewey-label">Full name</label>
          <input className="dewey-input" value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="dewey-label">Nickname</label>
            <input className="dewey-input" value={nickname} onChange={(e) => setNickname(e.target.value)} />
          </div>
          <div>
            <label className="dewey-label">Email</label>
            <input className="dewey-input" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="dewey-label">System role</label>
            <select
              className="dewey-input"
              value={systemRole}
              onChange={(e) => setSystemRole(e.target.value as SystemRole)}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="dewey-label">Job title</label>
            <input
              className="dewey-input"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              placeholder="e.g. 3rd Grade Teacher"
            />
          </div>
        </div>
        <OrgPickers
          districts={districts}
          districtId={districtId}
          schoolId={schoolId}
          onChange={({ district_id, school_id }) => {
            setDistrictId(district_id);
            setSchoolId(school_id);
          }}
        />
      </div>
      <div className="flex gap-2 mt-6 justify-end">
        <button type="button" className="dewey-btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="dewey-btn-primary w-auto" onClick={save} disabled={saving}>
          {saving ? "Creating…" : "Create user"}
        </button>
      </div>
    </ModalShell>
  );
}

// ============================================================
// Edit
// ============================================================

function UserEditModal({
  user,
  districts,
  isSelf,
  onClose,
  onSaved,
}: {
  user: User;
  districts: DistrictWithSchools[];
  isSelf: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [fullName, setFullName] = useState(user.full_name);
  const [nickname, setNickname] = useState(user.nickname ?? "");
  const [email, setEmail] = useState(user.email ?? "");
  const [systemRole, setSystemRole] = useState<SystemRole>(user.system_role);
  const [districtId, setDistrictId] = useState<number | null>(user.district_id);
  const [schoolId, setSchoolId] = useState<number | null>(user.school_id);
  const [role, setRole] = useState(user.role ?? "");
  const [about, setAbout] = useState(user.about ?? "");
  const [newPassword, setNewPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // RAG collection override. The user overrides when settings.ragCollections is
  // an array; otherwise they inherit the system defaults.
  const initialOverride = Array.isArray(user.settings?.ragCollections);
  const [overrideColls, setOverrideColls] = useState(initialOverride);
  const [selectedColls, setSelectedColls] = useState<string[]>(
    initialOverride ? (user.settings.ragCollections as string[]) : []
  );
  const [availColls, setAvailColls] = useState<string[]>([]);
  const [systemDefaults, setSystemDefaults] = useState<string[]>([]);
  const [collsLoading, setCollsLoading] = useState(false);
  const [collsError, setCollsError] = useState<string | null>(null);

  const [logs, setLogs] = useState<UserLogView[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLogsLoading(true);
    apiFetch<{ logs: UserLogView[] }>(`/api/admin/users/${user.id}/logs`)
      .then((d) => {
        if (!cancelled) setLogs(d.logs ?? []);
      })
      .catch(() => {
        if (!cancelled) setLogs([]);
      })
      .finally(() => {
        if (!cancelled) setLogsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user.id]);

  useEffect(() => {
    let cancelled = false;
    setCollsLoading(true);
    Promise.all([
      apiFetch<{ collections: string[] }>("/api/admin/rag/collections", {
        method: "POST",
        body: {},
      }).catch((e) => {
        if (!cancelled) setCollsError(e instanceof Error ? e.message : "RAGDoll unreachable");
        return { collections: [] as string[] };
      }),
      apiFetch<{ settings: { rag_default_collections: string[] } }>(
        "/api/admin/settings"
      ).catch(() => ({ settings: { rag_default_collections: [] as string[] } })),
    ]).then(([c, s]) => {
      if (cancelled) return;
      setAvailColls(c.collections ?? []);
      setSystemDefaults(s.settings?.rag_default_collections ?? []);
    }).finally(() => {
      if (!cancelled) setCollsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const allColls = Array.from(new Set([...availColls, ...selectedColls])).sort((a, b) =>
    a.localeCompare(b)
  );

  const toggleColl = (name: string) =>
    setSelectedColls((prev) =>
      prev.includes(name) ? prev.filter((c) => c !== name) : [...prev, name]
    );

  const save = async () => {
    setErr(null);
    if (newPassword && newPassword.length < 8) {
      setErr("New password must be at least 8 characters.");
      return;
    }
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        full_name: fullName,
        nickname,
        email,
        system_role: systemRole,
        district_id: districtId,
        school_id: schoolId,
        role,
        about,
        // Array overrides; null clears the override (inherit system defaults).
        rag_collections_override: overrideColls ? selectedColls : null,
      };
      if (newPassword) body.password = newPassword;
      await apiFetch(`/api/admin/users/${user.id}`, { method: "PATCH", body });
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Delete ${user.full_name} (@${user.username})? This cannot be undone.`)) return;
    setDeleting(true);
    setErr(null);
    try {
      await apiFetch(`/api/admin/users/${user.id}`, { method: "DELETE" });
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to delete");
      setDeleting(false);
    }
  };

  return (
    <ModalShell title={`Edit @${user.username}`} onClose={onClose}>
      <div className="space-y-4">
        {err && <p className="text-sm text-red-600">{err}</p>}
        <div>
          <label className="dewey-label">Full name</label>
          <input className="dewey-input" value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="dewey-label">Nickname</label>
            <input className="dewey-input" value={nickname} onChange={(e) => setNickname(e.target.value)} />
          </div>
          <div>
            <label className="dewey-label">Email</label>
            <input className="dewey-input" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="dewey-label">
              System role
              {isSelf && <span className="text-xs text-dewey-mute ml-1">(your account)</span>}
            </label>
            <select
              className="dewey-input"
              value={systemRole}
              onChange={(e) => setSystemRole(e.target.value as SystemRole)}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="dewey-label">Job title</label>
            <input className="dewey-input" value={role} onChange={(e) => setRole(e.target.value)} />
          </div>
        </div>
        <OrgPickers
          districts={districts}
          districtId={districtId}
          schoolId={schoolId}
          onChange={({ district_id, school_id }) => {
            setDistrictId(district_id);
            setSchoolId(school_id);
          }}
        />
        <div>
          <label className="dewey-label">About (coaching context)</label>
          <textarea
            className="dewey-input min-h-[80px]"
            value={about}
            onChange={(e) => setAbout(e.target.value)}
          />
        </div>

        {/* RAG collection override */}
        <div>
          <label className="flex items-center gap-2 text-sm font-medium text-dewey-ink">
            <input
              type="checkbox"
              checked={overrideColls}
              onChange={(e) => setOverrideColls(e.target.checked)}
            />
            Override default RAG collections
          </label>
          {!overrideColls ? (
            <p className="text-xs text-dewey-mute mt-1">
              Inherits the system default
              {systemDefaults.length > 0 ? `: ${systemDefaults.join(", ")}` : " (none set)"}.
            </p>
          ) : (
            <div className="mt-2">
              {collsLoading && <p className="text-xs text-dewey-mute">Loading collections…</p>}
              {collsError && <p className="text-xs text-red-600">{collsError}</p>}
              {allColls.length === 0 && !collsLoading ? (
                <p className="text-xs text-dewey-mute">
                  No collections available — configure RAGDoll in system settings.
                </p>
              ) : (
                <div className="border border-dewey-border rounded-md p-2 max-h-40 overflow-y-auto space-y-1 bg-dewey-surface">
                  {allColls.map((name) => (
                    <label key={name} className="flex items-center gap-2 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selectedColls.includes(name)}
                        onChange={() => toggleColl(name)}
                      />
                      <span>{name}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div>
          <label className="dewey-label">Reset password</label>
          <input
            type="password"
            className="dewey-input"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="Leave blank to keep current password"
            autoComplete="new-password"
          />
        </div>

        {/* Audit log */}
        <div>
          <label className="dewey-label">Activity</label>
          {logsLoading ? (
            <p className="text-xs text-dewey-mute">Loading…</p>
          ) : logs.length === 0 ? (
            <p className="text-xs text-dewey-mute">No activity recorded yet.</p>
          ) : (
            <ul className="border border-dewey-border rounded-md divide-y divide-dewey-border max-h-44 overflow-y-auto bg-dewey-surface">
              {logs.map((l) => {
                const meta: string[] = [];
                if (l.detail) meta.push(l.detail);
                if (l.actor_name && (l.action === "created" || l.action === "updated"))
                  meta.push(`by ${l.actor_name}`);
                return (
                  <li key={l.id} className="px-3 py-2 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-dewey-ink">
                        {ACTION_LABELS[l.action] ?? l.action}
                      </span>
                      <span className="text-dewey-mute shrink-0">
                        {new Date(l.created_at).toLocaleString()}
                      </span>
                    </div>
                    {meta.length > 0 && (
                      <div className="text-dewey-mute mt-0.5">{meta.join(" · ")}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
      <div className="flex gap-2 mt-6 justify-between">
        <button
          type="button"
          className="px-4 py-2 border border-red-200 text-red-700 rounded-md hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={remove}
          disabled={deleting || isSelf}
          title={isSelf ? "You can't delete your own account." : undefined}
        >
          {deleting ? "Deleting…" : "Delete"}
        </button>
        <div className="flex gap-2">
          <button type="button" className="dewey-btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="dewey-btn-primary w-auto" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
