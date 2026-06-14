"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useSession } from "next-auth/react";
import { apiFetch } from "@/lib/api-client";
import { rootPath } from "@/lib/base-path";
import { useDialog } from "@/components/DialogProvider";

// Opening a template from a log entry shows it in a read-only canvas overlay.
const TemplateReadOnly = dynamic(
  () => import("./TemplateCanvas").then((m) => m.TemplateReadOnly),
  { ssr: false }
);
// Opening a conversation from a log entry shows it in a read-only modal.
const ThreadViewer = dynamic(
  () => import("@/components/messages/ThreadViewer").then((m) => m.ThreadViewer),
  { ssr: false }
);

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
  school_ids: number[];
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

type LogEntityType = "template" | "message" | "user" | "district" | "school";

type UserLogView = {
  id: number;
  action: string;
  detail: string | null;
  created_at: string;
  actor_name: string | null;
  entity_type: LogEntityType | null;
  entity_id: number | null;
  entity_label: string | null;
};

type ConversationRow = {
  id: number;
  context_type: string;
  context_name: string | null;
  message_count: number;
  updated_at: string;
  preview: string | null;
};
type TranscriptMessage = {
  id: number;
  role: "user" | "assistant";
  content: string;
  created_at: string;
  flagged?: boolean;
};

const ACTION_LABELS: Record<string, string> = {
  created: "Account created",
  updated: "Updated",
  impersonated: "Admin signed in as user",
  signed_in: "Signed in",
  signed_out: "Signed out",
  user_deleted: "Deleted a user",
  district_created: "Created a district",
  district_deleted: "Deleted a district",
  school_created: "Created a school",
  school_deleted: "Deleted a school",
  settings_updated: "Updated system settings",
  template_created: "Created a plan",
  template_updated: "Edited a plan",
  template_published: "Published a plan to global",
  template_deleted: "Deleted a plan",
  template_duplicated: "Duplicated a plan",
  template_shared: "Shared a plan",
  template_submitted: "Submitted a plan",
  template_approved: "Approved a plan",
  template_rejected: "Rejected a plan",
  compliance_flagged: "Compliance screen flagged a message",
  partnership_created: "Created a partnership",
  partnership_done: "Marked a partnership done",
  partnership_abandoned: "Abandoned a partnership",
  partnership_reopened: "Reopened a partnership",
  partnership_renamed: "Renamed a partnership",
  thread_renamed: "Renamed a conversation",
  message_sent: "Sent a message",
  thread_archived: "Archived a conversation",
  thread_unarchived: "Unarchived a conversation",
  plan_added: "Added a plan to a conversation",
  plan_dismissed: "Dismissed a plan",
  plan_accepted: "Accepted a plan",
  plan_unlocked: "Unlocked a plan",
  plan_edited: "Edited a partnership plan",
  plan_finished: "Marked a plan finished",
  plan_abandoned: "Marked a plan abandoned",
  plan_reopened: "Reopened a plan",
  plan_revived: "Revived a plan",
  plan_advanced: "Advanced to the next activity",
  plan_completed: "Completed a plan",
  phase_advanced: "Advanced to the next phase",
  activity_submitted: "Submitted an activity for review",
  activity_withdrawn: "Withdrew a submission",
  activity_attested: "Attested an activity complete",
  activity_approved: "Approved an activity submission",
  activity_returned: "Returned a submission with feedback",
  activity_consulted: "Consulted Dewey on a submission",
  dewey_replied: "@dewey replied",
  participant_added: "Added someone to a conversation",
  invitation_accepted: "Accepted a partnership",
  invitation_declined: "Declined a partnership",
  restored: "Restored",
};

// Actions that hid an entity — these rows offer a Restore action.
const DELETE_ACTIONS = new Set([
  "user_deleted",
  "template_deleted",
  "district_deleted",
  "school_deleted",
]);

export function AdminUserManager() {
  const dialog = useDialog();
  const { data: session, update } = useSession();
  const currentUserId = session?.user?.id ? parseInt(session.user.id, 10) : null;

  const [users, setUsers] = useState<User[]>([]);
  const [impersonating, setImpersonating] = useState<number | null>(null);
  const [districts, setDistricts] = useState<DistrictWithSchools[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<User | null>(null);
  const [creating, setCreating] = useState(false);
  // A template opened from a log entry (read-only overlay).
  const [viewTemplateId, setViewTemplateId] = useState<number | null>(null);
  const [viewThreadId, setViewThreadId] = useState<number | null>(null);

  // Filters.
  const [query, setQuery] = useState("");
  const [filterDistrict, setFilterDistrict] = useState<number | null>(null);
  // "all" = any building; a number filters to users assigned to that building.
  const [filterSchool, setFilterSchool] = useState<"all" | number>("all");
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
        !(await dialog.confirm(
          `Log in as ${u.full_name} (@${u.username})? You'll see Dewey as this ${u.system_role}. A banner lets you return to admin.`,
          { title: "Log in as user", confirmText: "Log in as" }
        ))
      )
        return;
      setImpersonating(u.id);
      try {
        await update({ action: "impersonate", userId: u.id });
        // Hard navigation so the dispatcher routes by the now-impersonated role.
        window.location.href = rootPath;
      } catch (e) {
        dialog.alert(e instanceof Error ? e.message : "Failed to switch users");
        setImpersonating(null);
      }
    },
    [update, dialog]
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
    if (typeof filterSchool === "number" && !u.school_ids.includes(filterSchool)) {
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

  // Resolve a user's district + buildings to display names from the org tree.
  const orgLabel = (u: User): string => {
    const d = districts.find((x) => x.id === u.district_id);
    if (!d) return "Unassigned";
    if (u.school_ids.length === 0) return `${d.name} · No building`;
    if (d.schools.length > 0 && u.school_ids.length === d.schools.length)
      return `${d.name} · All buildings`;
    const names = u.school_ids
      .map((sid) => d.schools.find((x) => x.id === sid)?.name)
      .filter(Boolean);
    return `${d.name} · ${names.join(", ")}`;
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
                  setFilterSchool(v === "all" ? v : Number(v));
                }}
              >
                <option value="all">All buildings</option>
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
                    className="inline-flex items-center gap-1 rounded-full border border-dewey-accent/40 bg-dewey-accent/5 px-2 py-0.5 text-xs text-dewey-accent transition-colors hover:bg-dewey-accent/10 disabled:opacity-50"
                    onClick={(e) => {
                      e.stopPropagation();
                      loginAs(u);
                    }}
                    disabled={impersonating !== null}
                    title={`View Dewey as ${u.full_name}`}
                  >
                    <span aria-hidden>🔑</span>{" "}
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
          onOpenTemplate={(id) => setViewTemplateId(id)}
          onOpenThread={(id) => setViewThreadId(id)}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
        />
      )}

      {viewThreadId != null && (
        <ThreadViewer threadId={viewThreadId} onClose={() => setViewThreadId(null)} />
      )}

      {viewTemplateId != null && (
        // Wrapper sets a stacking context above the modals so the canvas covers them.
        <div className="relative z-[80]">
          <TemplateReadOnly templateId={viewTemplateId} onClose={() => setViewTemplateId(null)} />
        </div>
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
  schoolIds,
  onChange,
}: {
  districts: DistrictWithSchools[];
  districtId: number | null;
  schoolIds: number[];
  onChange: (next: { district_id: number | null; school_ids: number[] }) => void;
}) {
  const schools = districts.find((d) => d.id === districtId)?.schools ?? [];
  const allSelected = schools.length > 0 && schools.every((s) => schoolIds.includes(s.id));

  const toggle = (sid: number) =>
    onChange({
      district_id: districtId,
      school_ids: schoolIds.includes(sid)
        ? schoolIds.filter((s) => s !== sid)
        : [...schoolIds, sid],
    });

  return (
    <div className="space-y-3">
      <div>
        <label className="dewey-label">District</label>
        <select
          className="dewey-input"
          value={districtId ?? ""}
          onChange={(e) => {
            const next = e.target.value === "" ? null : Number(e.target.value);
            // Changing district clears now-invalid buildings.
            onChange({ district_id: next, school_ids: [] });
          }}
        >
          <option value="">— unassigned —</option>
          {districts.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
      </div>
      <div>
        <div className="flex items-center justify-between">
          <label className="dewey-label mb-0">Buildings</label>
          {districtId !== null && schools.length > 0 && (
            <button
              type="button"
              className="text-xs text-dewey-accent hover:underline"
              onClick={() =>
                onChange({
                  district_id: districtId,
                  school_ids: allSelected ? [] : schools.map((s) => s.id),
                })
              }
            >
              {allSelected ? "Clear all" : "Select all"}
            </button>
          )}
        </div>
        {districtId === null ? (
          <p className="text-xs text-dewey-mute">Select a district first.</p>
        ) : schools.length === 0 ? (
          <p className="text-xs text-dewey-mute">No buildings in this district yet.</p>
        ) : (
          <>
            <div className="mt-1 max-h-40 space-y-1 overflow-y-auto rounded-md border border-dewey-border p-2">
              {schools.map((s) => (
                <label key={s.id} className="flex items-center gap-2 text-sm text-dewey-ink">
                  <input
                    type="checkbox"
                    checked={schoolIds.includes(s.id)}
                    onChange={() => toggle(s.id)}
                  />
                  {s.name}
                </label>
              ))}
            </div>
            <p className="mt-1 text-xs text-dewey-mute">
              Assign one or more buildings (use Select all for everyone in the district).
            </p>
          </>
        )}
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
  const [schoolIds, setSchoolIds] = useState<number[]>([]);
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
          school_ids: schoolIds,
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
          schoolIds={schoolIds}
          onChange={({ district_id, school_ids }) => {
            setDistrictId(district_id);
            setSchoolIds(school_ids);
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
  onOpenTemplate,
  onOpenThread,
  onClose,
  onSaved,
}: {
  user: User;
  districts: DistrictWithSchools[];
  isSelf: boolean;
  onOpenTemplate: (id: number) => void;
  onOpenThread: (id: number) => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const dialog = useDialog();
  const [fullName, setFullName] = useState(user.full_name);
  const [nickname, setNickname] = useState(user.nickname ?? "");
  const [email, setEmail] = useState(user.email ?? "");
  const [systemRole, setSystemRole] = useState<SystemRole>(user.system_role);
  const [districtId, setDistrictId] = useState<number | null>(user.district_id);
  const [schoolIds, setSchoolIds] = useState<number[]>(user.school_ids ?? []);
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
  const [showFullLog, setShowFullLog] = useState(false);
  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [viewConversationId, setViewConversationId] = useState<number | null>(null);

  const reloadLogs = useCallback(() => {
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

  useEffect(() => reloadLogs(), [reloadLogs]);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ conversations: ConversationRow[] }>(`/api/admin/users/${user.id}/conversations`)
      .then((d) => {
        if (!cancelled) setConversations(d.conversations ?? []);
      })
      .catch(() => {
        if (!cancelled) setConversations([]);
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
        school_ids: schoolIds,
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
    if (
      !(await dialog.confirm(
        `Delete ${user.full_name} (@${user.username})? The account will be hidden and recoverable from the audit log.`,
        { title: "Delete user", confirmText: "Delete", danger: true }
      ))
    )
      return;
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
          schoolIds={schoolIds}
          onChange={({ district_id, school_ids }) => {
            setDistrictId(district_id);
            setSchoolIds(school_ids);
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

        {/* Audit log — newest 50 here; full, searchable log in a modal. */}
        <div>
          <div className="flex items-center justify-between">
            <label className="dewey-label mb-0">Activity</label>
            {logs.length > 0 && (
              <button
                type="button"
                className="text-xs text-dewey-accent hover:underline"
                onClick={() => setShowFullLog(true)}
              >
                View full log →
              </button>
            )}
          </div>
          <div className="mt-1">
            {logsLoading ? (
              <p className="text-xs text-dewey-mute">Loading…</p>
            ) : (
              <LogEntries logs={logs} onOpenTemplate={onOpenTemplate} onOpenThread={onOpenThread} onRestored={reloadLogs} />
            )}
          </div>
        </div>

        {/* AI conversations — full transcripts, admin-only. */}
        {conversations.length > 0 && (
          <div>
            <label className="dewey-label">@dewey conversations</label>
            <ul className="divide-y divide-dewey-border rounded-md border border-dewey-border bg-dewey-surface">
              {conversations.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    className="block w-full px-3 py-2 text-left text-xs hover:bg-dewey-surface-2"
                    onClick={() => setViewConversationId(c.id)}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-dewey-ink">
                        {c.context_name ? `Plan: ${c.context_name}` : "@dewey assistant"}
                      </span>
                      <span className="shrink-0 text-dewey-mute">
                        {c.message_count} msg · {new Date(c.updated_at).toLocaleDateString()}
                      </span>
                    </div>
                    {c.preview && <div className="mt-0.5 truncate text-dewey-mute">{c.preview}</div>}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
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

      {showFullLog && (
        <FullLogModal
          userId={user.id}
          userName={user.full_name}
          onOpenTemplate={onOpenTemplate} onOpenThread={onOpenThread}
          onClose={() => setShowFullLog(false)}
        />
      )}

      {viewConversationId != null && (
        <TranscriptModal
          conversationId={viewConversationId}
          userName={user.full_name}
          onClose={() => setViewConversationId(null)}
        />
      )}
    </ModalShell>
  );
}

/** Read-only full transcript of one AI conversation (admin view). */
function TranscriptModal({
  conversationId,
  userName,
  onClose,
}: {
  conversationId: number;
  userName: string;
  onClose: () => void;
}) {
  const [summary, setSummary] = useState<string | null>(null);
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ conversation: { summary: string | null }; messages: TranscriptMessage[] }>(
      `/api/admin/conversations/${conversationId}`
    )
      .then((d) => {
        if (cancelled) return;
        setSummary(d.conversation.summary);
        setMessages(d.messages ?? []);
      })
      .catch(() => {
        if (!cancelled) setMessages([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-lg bg-dewey-surface p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-lg font-semibold">Transcript — {userName}</h3>
          <button
            type="button"
            className="text-sm text-dewey-mute hover:text-dewey-ink"
            onClick={onClose}
          >
            Close
          </button>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto">
          {loading ? (
            <p className="text-xs text-dewey-mute">Loading…</p>
          ) : (
            <>
              {summary && (
                <div className="rounded-md border border-dewey-border bg-dewey-surface-2 p-2 text-xs text-dewey-mute">
                  <span className="font-medium text-dewey-ink">Summary of earlier turns: </span>
                  {summary}
                </div>
              )}
              {messages.length === 0 ? (
                <p className="text-xs text-dewey-mute">No messages.</p>
              ) : (
                messages.map((m) => (
                  <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                    <div
                      className={`max-w-[85%] rounded-lg border px-3 py-2 text-sm ${
                        m.flagged
                          ? "border-red-300 bg-red-50"
                          : `border-dewey-border ${m.role === "user" ? "bg-dewey-accent/15" : "bg-dewey-surface"}`
                      }`}
                    >
                      <div className="mb-0.5 text-[11px] text-dewey-mute">
                        {m.role === "user" ? userName : "@dewey"} ·{" "}
                        {new Date(m.created_at).toLocaleString()}
                        {m.flagged && (
                          <span className="ml-1 font-medium text-red-600">· flagged</span>
                        )}
                      </div>
                      <div className="whitespace-pre-wrap text-dewey-ink">{m.content}</div>
                    </div>
                  </div>
                ))
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Audit-log rendering
// ============================================================

/** Renders a list of audit-log entries, deep-linking templates and offering restore. */
function LogEntries({
  logs,
  onOpenTemplate,
  onOpenThread,
  onRestored,
}: {
  logs: UserLogView[];
  onOpenTemplate: (id: number) => void;
  onOpenThread: (id: number) => void;
  onRestored: () => void;
}) {
  if (logs.length === 0) {
    return <p className="text-xs text-dewey-mute">No activity recorded yet.</p>;
  }
  return (
    <ul className="border border-dewey-border rounded-md divide-y divide-dewey-border max-h-44 overflow-y-auto bg-dewey-surface">
      {logs.map((l) => (
        <LogRow key={l.id} log={l} onOpenTemplate={onOpenTemplate} onOpenThread={onOpenThread} onRestored={onRestored} />
      ))}
    </ul>
  );
}

function LogRow({
  log: l,
  onOpenTemplate,
  onOpenThread,
  onRestored,
}: {
  log: UserLogView;
  onOpenTemplate: (id: number) => void;
  onOpenThread: (id: number) => void;
  onRestored: () => void;
}) {
  const dialog = useDialog();
  const [restoring, setRestoring] = useState(false);
  const meta: string[] = [];
  // Skip detail when it just repeats the entity label (e.g. delete entries).
  if (l.detail && l.detail !== l.entity_label) meta.push(l.detail);
  if (l.actor_name && (l.action === "created" || l.action === "updated"))
    meta.push(`by ${l.actor_name}`);
  const linksTemplate = l.entity_type === "template" && l.entity_id != null;
  const linksThread = l.entity_type === "message" && l.entity_id != null;
  const linkable = linksTemplate || linksThread;
  const restorable = DELETE_ACTIONS.has(l.action) && l.entity_type != null && l.entity_id != null;

  const restore = async () => {
    setRestoring(true);
    try {
      await apiFetch("/api/admin/restore", {
        method: "POST",
        body: { entityType: l.entity_type, entityId: l.entity_id },
      });
      onRestored();
    } catch (e) {
      dialog.alert(e instanceof Error ? e.message : "Failed to restore");
      setRestoring(false);
    }
  };

  return (
    <li className="px-3 py-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-dewey-ink">{ACTION_LABELS[l.action] ?? l.action}</span>
        <div className="flex shrink-0 items-center gap-2">
          {restorable && (
            <button
              type="button"
              className="text-dewey-accent hover:underline disabled:opacity-50"
              onClick={restore}
              disabled={restoring}
            >
              {restoring ? "Restoring…" : "Restore"}
            </button>
          )}
          <span className="text-dewey-mute">{new Date(l.created_at).toLocaleString()}</span>
        </div>
      </div>
      {l.entity_label && (
        <div className="mt-0.5">
          {linkable ? (
            <button
              type="button"
              className="text-dewey-accent hover:underline"
              onClick={() =>
                linksTemplate
                  ? onOpenTemplate(l.entity_id as number)
                  : onOpenThread(l.entity_id as number)
              }
            >
              {l.entity_label} ↗
            </button>
          ) : (
            <span className="text-dewey-ink">{l.entity_label}</span>
          )}
        </div>
      )}
      {meta.length > 0 && <div className="mt-0.5 text-dewey-mute">{meta.join(" · ")}</div>}
    </li>
  );
}

/** Full, searchable audit log for one user. Results narrow live as you type. */
function FullLogModal({
  userId,
  userName,
  onOpenTemplate,
  onOpenThread,
  onClose,
}: {
  userId: number;
  userName: string;
  onOpenTemplate: (id: number) => void;
  onOpenThread: (id: number) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [logs, setLogs] = useState<UserLogView[]>([]);
  const [loading, setLoading] = useState(true);
  // Bumped to force a refetch after a restore.
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // Debounce so each keystroke doesn't fire a request.
    const t = setTimeout(() => {
      const query = q.trim();
      const url = `/api/admin/users/${userId}/logs?limit=1000${
        query ? `&q=${encodeURIComponent(query)}` : ""
      }`;
      apiFetch<{ logs: UserLogView[] }>(url)
        .then((d) => {
          if (!cancelled) setLogs(d.logs ?? []);
        })
        .catch(() => {
          if (!cancelled) setLogs([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [userId, q, refreshKey]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-lg bg-dewey-surface p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-lg font-semibold">Activity — {userName}</h3>
          <button
            type="button"
            className="text-sm text-dewey-mute hover:text-dewey-ink"
            onClick={onClose}
          >
            Close
          </button>
        </div>
        <input
          type="search"
          autoFocus
          className="dewey-input"
          placeholder="Search activity…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="mt-3 flex-1 overflow-y-auto">
          {loading ? (
            <p className="text-xs text-dewey-mute">Loading…</p>
          ) : logs.length === 0 ? (
            <p className="py-4 text-center text-xs text-dewey-mute">
              {q.trim() ? "No matching activity." : "No activity recorded yet."}
            </p>
          ) : (
            <ul className="divide-y divide-dewey-border rounded-md border border-dewey-border bg-dewey-surface">
              {logs.map((l) => (
                <LogRow
                  key={l.id}
                  log={l}
                  onOpenTemplate={onOpenTemplate} onOpenThread={onOpenThread}
                  onRestored={() => setRefreshKey((k) => k + 1)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
